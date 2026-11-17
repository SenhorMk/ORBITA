import { createLocalDatabaseClient } from './local-database-client.mjs';
import { err, ok } from './script-result.mjs';
import { aceitar, aplicar, comandoDaMensagem, novaOrganizacao, reivindicar } from './database-concurrency-consumidor-inbox-apoio.mjs';

/**
 * MSG-013. Prova contra Postgres real, como `service_role`, que o orçamento
 * diário da triagem não estoura sob concorrência e é isolado por organização:
 *
 * 1. uma sessão segura a trava do orçamento da organização com a transação
 *    aberta; a segunda espera no Postgres (wait_event=advisory) e, quando a
 *    primeira confirma, já vê o orçamento gasto;
 * 2. dezesseis inícios simultâneos, oito da A e oito da B, com limite 3: cada
 *    organização inicia exatamente 3 e as demais viram `sem_orcamento`, sem
 *    uma bloquear a conta da outra;
 * 3. depois da corrida, a leitura do cockpit mostra para cada caso a execução
 *    do próprio caso (em andamento ou sem orçamento), e a Org B não lê caso da A;
 * 4. conclusão × mensagem nova da inbox, com barreiras: a inbox atualiza o caso
 *    e segura a transação; a conclusão espera (wait_event=transactionid) e,
 *    quando a inbox confirma, grava `obsoleta`. Na ordem inversa, a inbox
 *    espera a conclusão, que grava `concluida` para a versão antiga, e a
 *    mensagem nova enfileira a próxima triagem. Contraprova: a leitura sem
 *    trava (como antes da correção) via a versão antiga com a mensagem nova
 *    pronta para confirmar.
 * 5. worker com a lease vencida concluindo × outro worker retomando o mesmo
 *    evento: a retomada trava o evento (primeiro passo do início) e segura a
 *    transação; a conclusão do primeiro espera no evento sem segurar a
 *    execução, a retomada fecha a execução antiga como interrompida, e a
 *    conclusão tardia recebe `posse_perdida`. Com a conclusão travando a
 *    execução antes do evento (ordem anterior), o Postgres derrubava a
 *    retomada com deadlock (40P01).
 */

const INICIAR = "select public.iniciar_triagem_sac($1, $2, $3, $4, 'fake', 'falso-v1', 'triagem-v1', 1) as r";
const LER = 'select public.ler_triagem_do_caso_sac($1, $2) as r';
const WORKER = 'w-triagem-corrida';
const CONCLUIR = "select public.concluir_triagem_sac($1, $2, $3, 'concluida', null, '{\"versao\":1}'::jsonb, true, 10, 5, 0::smallint, 100) as r";

/** `quantos` casos novos numa organização nova; cada um enfileira uma triagem. */
async function casosNovos(admin, cliente, sufixo, quantos, base) {
  const { org, conexao } = await novaOrganizacao(admin, `m13-${sufixo}`);
  const conversas = [];
  for (let i = 0; i < quantos; i += 1) {
    const evento = await aceitar(cliente, org, conexao, `m13-${sufixo}-${i}-${conexao}`);
    const meu = (await reivindicar(cliente, `m13-inbox-${sufixo}`)).find((linha) => linha.evento_id === evento.evento_id);
    await aplicar(cliente, meu.evento_id, `m13-inbox-${sufixo}`, meu.fencing_token, comandoDaMensagem(base + i, base + i, base + i));
    const { rows: [{ conversa }] } = await admin.query(
      'select id_local as conversa from public.chatwoot_conversations where conexao_id = $1 and id_externo = $2', [conexao, String(base + i)]);
    conversas.push(conversa);
  }
  return { org, conexao, conversas };
}

/** Reivindica as triagens pendentes; devolve as da organização pedida. */
async function triagensDe(cliente, orgs) {
  const { rows } = await cliente.query('select * from public.reivindicar_triagens_sac($1, 20, 120)', [WORKER]);
  return rows.filter((linha) => orgs.includes(linha.organizacao_id));
}

async function esperarAdvisory(admin, pid, evento = 'advisory') {
  for (let i = 0; i < 100; i += 1) {
    const { rows: [linha] } = await admin.query('select wait_event_type, wait_event from pg_stat_activity where pid = $1', [pid]);
    if (linha?.wait_event_type === 'Lock' && linha.wait_event === evento) return true;
    await new Promise((r) => { setTimeout(r, 50); });
  }
  return false;
}

async function travaSerializa({ admin, pool }) {
  const alvo = await casosNovos(admin, pool[0], 'trava', 2, 9600);
  const [primeira, segunda] = await triagensDe(pool[0], [alvo.org]);
  const [x, y] = pool;
  await x.query('begin');
  const r1 = (await x.query(INICIAR, [primeira.evento_id, WORKER, primeira.fencing_token, 1])).rows[0].r.resultado;
  const { rows: [{ pid }] } = await y.query('select pg_backend_pid() as pid');
  const pendente = y.query(INICIAR, [segunda.evento_id, WORKER, segunda.fencing_token, 1]);
  const esperou = await esperarAdvisory(admin, pid);
  await x.query('commit');
  const r2 = (await pendente).rows[0].r.resultado;
  if (r1 !== 'iniciada' || !esperou || r2 !== 'sem_orcamento') {
    return err('OrcamentoSemTrava', 'o início concorrente não esperou a trava do orçamento', { r1, esperou, r2 });
  }
  return ok({ resumo: 'trava do orçamento: o segundo início esperou (wait_event=advisory) e viu o orçamento gasto (sem_orcamento)' });
}

async function corridaPorOrganizacao({ admin, pool }) {
  const a = await casosNovos(admin, pool[0], 'corrida-a', 8, 9700);
  const b = await casosNovos(admin, pool[0], 'corrida-b', 8, 9800);
  const eventos = await triagensDe(pool[0], [a.org, b.org]);
  if (eventos.length !== 16) return err('TriagensNaoEnfileiradas', 'esperava 16 triagens reivindicadas', { total: eventos.length });

  const resultados = await Promise.all(eventos.map(async (e, i) => ({
    org: e.organizacao_id,
    resultado: (await pool[i % pool.length].query(INICIAR, [e.evento_id, WORKER, e.fencing_token, 3])).rows[0].r.resultado,
  })));
  const conta = (org, r) => resultados.filter((x) => x.org === org && x.resultado === r).length;
  const resumo = { aIniciadas: conta(a.org, 'iniciada'), aSem: conta(a.org, 'sem_orcamento'), bIniciadas: conta(b.org, 'iniciada'), bSem: conta(b.org, 'sem_orcamento') };
  const { rows: [banco] } = await admin.query(
    `select count(*) filter (where organizacao_id = $1 and status = 'em_andamento')::int as a,
            count(*) filter (where organizacao_id = $2 and status = 'em_andamento')::int as b
       from public.ai_runs`, [a.org, b.org]);
  if (resumo.aIniciadas !== 3 || resumo.aSem !== 5 || resumo.bIniciadas !== 3 || resumo.bSem !== 5 || banco.a !== 3 || banco.b !== 3) {
    return err('OrcamentoEstourado', 'a corrida passou do limite ou misturou organizações', { resumo, banco });
  }

  const lidos = await Promise.all(a.conversas.map(async (conversa, i) =>
    (await pool[i % pool.length].query(LER, [a.org, conversa])).rows[0].r));
  const status = lidos.map((l) => l.execucao?.status).sort();
  const alheio = (await pool[0].query(LER, [b.org, a.conversas[0]])).rows[0].r.resultado;
  const esperado = ['em_andamento', 'em_andamento', 'em_andamento', 'handoff', 'handoff', 'handoff', 'handoff', 'handoff'];
  if (JSON.stringify(status) !== JSON.stringify(esperado) || alheio !== 'conversa_inexistente') {
    return err('LeituraErrada', 'a leitura depois da corrida não mostrou a execução do próprio caso', { status, alheio });
  }
  return ok({ resumo: '16 inícios simultâneos (8 da A, 8 da B) com limite 3: A iniciou 3 e 5 sem orçamento, B iniciou 3 e 5 sem orçamento; o cockpit leu a execução de cada caso e a B não leu caso da A' });
}

/** Um caso com triagem iniciada e a próxima mensagem do contato já aceita e reivindicada na inbox. */
async function casoEmTriagem(admin, cliente, sufixo, base) {
  const alvo = await casosNovos(admin, cliente, sufixo, 1, base);
  const [triagem] = await triagensDe(cliente, [alvo.org]);
  const inicio = (await cliente.query(INICIAR, [triagem.evento_id, WORKER, triagem.fencing_token, 5])).rows[0].r;
  const { rows: [run] } = await admin.query('select mensagens_ate, caso_id from public.ai_runs where id = $1', [inicio.run_id]);
  const evento = await aceitar(cliente, alvo.org, alvo.conexao, `m13-${sufixo}-nova-${alvo.conexao}`);
  const inbox = (await reivindicar(cliente, `m13-inbox-${sufixo}`)).find((linha) => linha.evento_id === evento.evento_id);
  return {
    ...alvo, triagem, runId: inicio.run_id, inicio: inicio.resultado, mensagensAte: run.mensagens_ate, casoId: run.caso_id, inbox,
    novaMensagem: comandoDaMensagem(base * 10 + 1, base, base),
  };
}

async function estadoDoCaso(admin, alvo) {
  const { rows: [linha] } = await admin.query(
    `select r.status, r.motivo, r.mensagens_ate, s.ultima_mensagem_em,
            (select count(*)::int from public.outbox_eventos o where o.destination = 'interno' and o.status = 'pending'
              and o.payload ->> 'caso_id' = s.id::text and (o.payload ->> 'mensagens_ate')::timestamptz = s.ultima_mensagem_em) as proxima
       from public.ai_runs r join public.sac_cases s on s.id = r.caso_id where r.id = $1`, [alvo.runId]);
  return linha;
}

async function conclusaoContraInbox({ admin, pool }) {
  const [x, y] = pool;
  const { rows: [{ pid: pidY }] } = await y.query('select pg_backend_pid() as pid');
  const { rows: [{ pid: pidX }] } = await x.query('select pg_backend_pid() as pid');

  // Ordem 1: a mensagem nova chega primeiro e segura a transação.
  const a = await casoEmTriagem(admin, pool[0], 'conclusao-depois', 9900);
  await x.query('begin');
  await aplicar(x, a.inbox.evento_id, 'm13-inbox-conclusao-depois', a.inbox.fencing_token, a.novaMensagem);
  const { rows: [vista] } = await y.query('select ultima_mensagem_em from public.sac_cases where id = $1', [a.casoId]);
  const semTravaViuAntiga = vista.ultima_mensagem_em.getTime() === a.mensagensAte.getTime();
  const concluindo = y.query(CONCLUIR, [a.runId, WORKER, a.triagem.fencing_token]);
  const conclusaoEsperou = await esperarAdvisory(admin, pidY, 'transactionid');
  await x.query('commit');
  const r1 = (await concluindo).rows[0].r;
  const e1 = await estadoDoCaso(admin, a);

  // Ordem 2: a conclusão chega primeiro e segura a transação.
  const b = await casoEmTriagem(admin, pool[0], 'conclusao-antes', 9950);
  await y.query('begin');
  const r2 = (await y.query(CONCLUIR, [b.runId, WORKER, b.triagem.fencing_token])).rows[0].r;
  const aplicando = aplicar(x, b.inbox.evento_id, 'm13-inbox-conclusao-antes', b.inbox.fencing_token, b.novaMensagem);
  const inboxEsperou = await esperarAdvisory(admin, pidX, 'transactionid');
  await y.query('commit');
  await aplicando;
  const e2 = await estadoDoCaso(admin, b);
  const lido = (await pool[0].query(LER, [b.org, b.conversas[0]])).rows[0].r;

  const certo = a.inicio === 'iniciada' && b.inicio === 'iniciada' && semTravaViuAntiga && conclusaoEsperou && inboxEsperou
    && r1 === 'obsoleta' && e1.status === 'obsoleta' && e1.motivo === 'caso_mudou' && e1.ultima_mensagem_em > e1.mensagens_ate && e1.proxima === 1
    && r2 === 'concluida' && e2.status === 'concluida' && e2.ultima_mensagem_em > e2.mensagens_ate && e2.proxima === 1
    && lido.execucao?.status === 'concluida' && lido.pendente === true;
  if (!certo) {
    const fatos = `inícios ${a.inicio}/${b.inicio}; leitura sem trava viu a antiga: ${semTravaViuAntiga}; conclusão esperou: ${conclusaoEsperou}; `
      + `ordem 1 gravou ${r1} (${e1.status}, próxima ${e1.proxima}); inbox esperou: ${inboxEsperou}; ordem 2 gravou ${r2} (${e2.status}, próxima ${e2.proxima}); `
      + `cockpit ${lido.execucao?.status}, pendente ${lido.pendente}`;
    return err('ConclusaoForaDeOrdem', `a conclusão e a mensagem nova não seguiram a ordem de commit: ${fatos}`, {
      inicios: [a.inicio, b.inicio], semTravaViuAntiga, conclusaoEsperou, inboxEsperou, r1, e1, r2, e2, lido: { status: lido.execucao?.status, pendente: lido.pendente },
    });
  }
  return ok({ resumo: 'conclusão × mensagem nova: com a inbox segurando o caso, a conclusão esperou (wait_event=transactionid) e gravou obsoleta; com a conclusão segurando, a inbox esperou (wait_event=transactionid), a conclusão gravou concluida para a versão antiga e a próxima triagem ficou na fila (cockpit: concluida, pendente); contraprova: a leitura sem trava via a versão antiga' });
}

async function zumbiContraRetomada({ admin, pool }) {
  const [x, y, z] = pool;
  const { rows: [{ pid: pidX }] } = await x.query('select pg_backend_pid() as pid');
  const alvo = await casosNovos(admin, z, 'zumbi', 1, 9980);
  const [triagem] = await triagensDe(z, [alvo.org]);
  const inicio = (await z.query(INICIAR, [triagem.evento_id, WORKER, triagem.fencing_token, 5])).rows[0].r;

  // A lease do primeiro worker vence; o reaper devolve o evento e outro worker o reivindica.
  await admin.query("update public.outbox_eventos set lease_expires_at = now() - interval '1 second' where id = $1", [triagem.evento_id]);
  await admin.query('select public.liberar_leases_expirados_outbox()');
  await admin.query('update public.outbox_eventos set next_retry_at = now() where id = $1', [triagem.evento_id]);
  const { rows: retomadas } = await z.query("select * from public.reivindicar_triagens_sac('w-retomada', 20, 120)");
  const retomada = retomadas.find((linha) => linha.evento_id === triagem.evento_id);

  await y.query('begin');
  await y.query('select id from public.outbox_eventos where id = $1 for update', [triagem.evento_id]);
  const concluindo = x.query(CONCLUIR, [inicio.run_id, WORKER, triagem.fencing_token])
    .then((r) => r.rows[0].r, (erro) => `erro:${erro.code}`);
  const zumbiEsperou = await esperarAdvisory(admin, pidX, 'transactionid');
  let retomou;
  try {
    retomou = (await y.query(INICIAR, [triagem.evento_id, 'w-retomada', retomada?.fencing_token, 5])).rows[0].r.resultado;
    await y.query('commit');
  } catch (erro) {
    retomou = `erro:${erro.code}`;
    await y.query('rollback');
  }
  const concluiu = await concluindo;
  const { rows: [antiga] } = await admin.query('select status, motivo from public.ai_runs where id = $1', [inicio.run_id]);

  const certo = inicio.resultado === 'iniciada' && retomada !== undefined && zumbiEsperou
    && retomou === 'iniciada' && concluiu === 'posse_perdida' && antiga.status === 'falha' && antiga.motivo === 'interrompida';
  if (!certo) {
    const fatos = `início ${inicio.resultado}; retomada reivindicada: ${retomada !== undefined}; conclusão esperou: ${zumbiEsperou}; `
      + `retomada ${retomou}; conclusão ${concluiu}; execução antiga ${antiga.status}/${antiga.motivo}`;
    return err('ConclusaoContraRetomada', `conclusão tardia e retomada não seguiram a mesma ordem de travas: ${fatos}`, {
      inicio: inicio.resultado, zumbiEsperou, retomou, concluiu, antiga,
    });
  }
  return ok({ resumo: 'conclusão com lease vencida × retomada: a conclusão esperou no evento (wait_event=transactionid) sem segurar a execução, a retomada iniciou e fechou a execução antiga como interrompida, e a conclusão tardia recebeu posse_perdida (sem 40P01)' });
}

/**
 * @returns {Promise<object>} Resultado tagueado do rehearsal.
 */
export async function runTriagemRaceRehearsal() {
  const abertos = [];
  const novoCliente = async () => {
    const client = createLocalDatabaseClient('orbita-triagem');
    client.on('error', () => {});
    await client.connect();
    await client.query('set role service_role');
    await client.query("set request.jwt.claim.role = 'service_role'");
    abertos.push(client);
    return client;
  };
  const admin = createLocalDatabaseClient('orbita-triagem-admin');
  try {
    await admin.connect();
    // Isola esta prova das anteriores: inbox e triagens pendentes de outras etapas não são reivindicadas aqui.
    await admin.query("update public.inbox_eventos_chatwoot set available_at = 'infinity' where status in ('received', 'failed')");
    await admin.query("update public.outbox_eventos set next_retry_at = 'infinity' where destination = 'interno' and status in ('pending', 'failed_transient')");
    const pool = await Promise.all(Array.from({ length: 8 }, novoCliente));
    const ctx = { admin, pool };
    const resumos = [];
    for (const etapa of [travaSerializa, corridaPorOrganizacao, conclusaoContraInbox, zumbiContraRetomada]) {
      const resultado = await etapa(ctx);
      if (resultado._tag === 'err') return resultado;
      resumos.push(resultado.value.resumo);
    }
    return ok(Object.freeze({ relato: `triagem por IA (MSG-013) provada no Postgres: ${resumos.join('; ')}` }));
  } catch (cause) {
    return err('TriagemRehearsalFailed', 'Falha inesperada no rehearsal da triagem', {}, cause);
  } finally {
    for (const client of [admin, ...abertos]) {
      try {
        await client.end();
      } catch {
        // Encerramento de conexão de teste; nada a fazer se já caiu.
      }
    }
  }
}
