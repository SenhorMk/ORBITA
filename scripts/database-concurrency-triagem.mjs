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
 *    do próprio caso (em andamento ou sem orçamento), e a Org B não lê caso da A.
 */

const INICIAR = "select public.iniciar_triagem_sac($1, $2, $3, $4, 'fake', 'falso-v1', 'triagem-v1', 1) as r";
const LER = 'select public.ler_triagem_do_caso_sac($1, $2) as r';
const WORKER = 'w-triagem-corrida';

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
  return { org, conversas };
}

/** Reivindica as triagens pendentes; devolve as da organização pedida. */
async function triagensDe(cliente, orgs) {
  const { rows } = await cliente.query('select * from public.reivindicar_triagens_sac($1, 20, 120)', [WORKER]);
  return rows.filter((linha) => orgs.includes(linha.organizacao_id));
}

async function esperarAdvisory(admin, pid) {
  for (let i = 0; i < 100; i += 1) {
    const { rows: [linha] } = await admin.query('select wait_event_type, wait_event from pg_stat_activity where pid = $1', [pid]);
    if (linha?.wait_event_type === 'Lock' && linha.wait_event === 'advisory') return true;
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
    for (const etapa of [travaSerializa, corridaPorOrganizacao]) {
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
