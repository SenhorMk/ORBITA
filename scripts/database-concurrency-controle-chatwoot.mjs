import { createLocalDatabaseClient } from './local-database-client.mjs';
import { err, ok } from './script-result.mjs';
import { observarBloqueioNoPostgres } from './database-concurrency.mjs';
import { aceitar, aplicar, comandoDaMensagem, novaOrganizacao, reivindicar } from './database-concurrency-consumidor-inbox-apoio.mjs';

/**
 * MSG-009. Prova contra Postgres real, como `service_role`, que o controle do
 * atendimento e o início do despacho se excluem:
 *
 * 1. oito abas assumem a mesma conversa na mesma versão: uma aplica, sete conflitam;
 * 2. takeover com a trava do controle: o início do despacho espera (bloqueio
 *    observado no Postgres) e termina `invalidado`, sem tentativa de rede;
 * 3. início do despacho com a trava compartilhada: o takeover espera e, ao
 *    passar, conta a resposta em voo;
 * 4. vinte corridas soltas takeover × início: cada envio termina invalidado
 *    ou em voo contado pelo takeover, nunca em voo sem ninguém saber;
 * 5. vinte corridas com a resposta em `failed_transient`, takeover × novo
 *    claim e início: cancelada pelo takeover, invalidada no início ou em voo
 *    contado; a saúde da conexão não muda.
 *
 * Contraprova medida e revertida: sem conferir a versão no início, o envio de
 * uma conversa assumida depois do registro sairia.
 */

const REGISTRAR = 'select * from public.registrar_envio_chatwoot($1, $2, $3, gen_random_uuid(), $4)';
const ALTERAR = 'select * from public.alterar_controle_atendimento_chatwoot($1, $2, $3, gen_random_uuid(), $4, $5, $6)';
const REIVINDICAR = "select * from public.reivindicar_envios_chatwoot($1, 50, 60, 'epoch'::timestamptz, 2)";
const INICIAR = 'select public.iniciar_envio_chatwoot($1, $2, $3) as inicio';

/** Conversa nova numa organização nova, com duas atendentes (membros). */
async function novaConversa(admin, cliente, sufixo) {
  const { org, conexao } = await novaOrganizacao(admin, `m9-${sufixo}`);
  const atores = [];
  for (const nome of ['a', 'b']) {
    const { rows: [{ ator }] } = await admin.query('select gen_random_uuid() as ator');
    await admin.query('insert into auth.users (id, email) values ($1, $2)', [ator, `m9-${sufixo}-${nome}-${ator.slice(0, 8)}@orbita.test`]);
    await admin.query("insert into public.membros_organizacao (organizacao_id, user_id, papel) values ($1, $2, 'member')", [org, ator]);
    atores.push(ator);
  }
  const evento = await aceitar(cliente, org, conexao, `m9-${sufixo}-${conexao}`);
  const lote = await reivindicar(cliente, `m9-inbox-${sufixo}`);
  const meu = lote.find((linha) => linha.evento_id === evento.evento_id);
  await aplicar(cliente, meu.evento_id, `m9-inbox-${sufixo}`, meu.fencing_token, comandoDaMensagem(9000, 50, 5));
  const { rows: [{ conversa }] } = await admin.query(
    "select id_local as conversa from public.chatwoot_conversations where conexao_id = $1 and id_externo = '50'", [conexao]);
  return { org, conexao, conversa, a: atores[0], b: atores[1] };
}

/** A responde (assume, versão 1) e um worker reivindica o envio. */
async function envioReivindicado(admin, cliente, sufixo) {
  const alvo = await novaConversa(admin, cliente, sufixo);
  const { rows: [registro] } = await cliente.query(REGISTRAR, [alvo.org, alvo.a, alvo.conversa, 'resposta']);
  const lote = (await cliente.query(REIVINDICAR, [`w-${sufixo}`])).rows.find((r) => r.evento_id === registro.evento_id);
  return { ...alvo, evento: registro.evento_id, worker: `w-${sufixo}`, token: lote.fencing_token };
}

async function estadoDoEnvio(admin, evento) {
  const { rows: [linha] } = await admin.query(
    `select o.status, e.invalidado_em is not null as invalidado,
            (select count(*)::int from public.outbox_tentativas t where t.evento_id = o.id) as tentativas
       from public.outbox_eventos o join public.chatwoot_envios e on e.outbox_evento_id = o.id
      where o.id = $1`, [evento]);
  return linha;
}

async function abasConcorrentes({ admin, pool }) {
  const alvo = await novaConversa(admin, pool[0], 'abas');
  const resultados = await Promise.all(pool.map(async (client, i) =>
    (await client.query(ALTERAR, [alvo.org, i % 2 === 0 ? alvo.a : alvo.b, alvo.conversa, 'assumir', 0, null])).rows[0].resultado));
  const aplicados = resultados.filter((r) => r === 'aplicado').length;
  const conflitos = resultados.filter((r) => r === 'conflito_versao').length;
  const { rows: [controle] } = await admin.query(
    'select control_version from public.chatwoot_conversa_controle where conversa_id_local = $1', [alvo.conversa]);
  if (aplicados !== 1 || conflitos !== pool.length - 1 || Number(controle.control_version) !== 1) {
    return err('DoisDonos', 'mais de uma aba assumiu na mesma versão', { resultados, versao: controle.control_version });
  }
  return ok({ resumo: `${pool.length} abas na versão 0: 1 assumiu, ${conflitos} conflito_versao, versão final 1` });
}

async function takeoverPrimeiro({ admin, novoCliente }) {
  const [dono, worker] = [await novoCliente(), await novoCliente()];
  const alvo = await envioReivindicado(admin, dono, 'takeover-1o');
  await dono.query('begin');
  const { rows: [mudanca] } = await dono.query(ALTERAR, [alvo.org, alvo.b, alvo.conversa, 'assumir', 1, null]);
  const { rows: [{ pid }] } = await worker.query('select pg_backend_pid() as pid');
  const inicio = worker.query(INICIAR, [alvo.evento, alvo.worker, alvo.token]);
  const bloqueio = await observarBloqueioNoPostgres(admin, pid);
  await dono.query('commit');
  const { rows: [{ inicio: resultado }] } = await inicio;
  const estado = await estadoDoEnvio(admin, alvo.evento);
  if (mudanca.resultado !== 'aplicado' || !bloqueio.observado || resultado !== 'invalidado'
      || estado.status !== 'dead_letter' || !estado.invalidado || estado.tentativas !== 0) {
    return err('TakeoverNaoBarrou', 'o início passou por cima do takeover', { mudanca: mudanca.resultado, bloqueio, resultado, estado });
  }
  return ok({
    resumo: `takeover segura o controle: o início esperou (wait_event=${bloqueio.waitEvent}) e terminou invalidado, sem tentativa de rede`,
  });
}

async function inicioPrimeiro({ admin, novoCliente }) {
  const [worker, dono] = [await novoCliente(), await novoCliente()];
  const alvo = await envioReivindicado(admin, worker, 'inicio-1o');
  await worker.query('begin');
  const { rows: [{ inicio }] } = await worker.query(INICIAR, [alvo.evento, alvo.worker, alvo.token]);
  const { rows: [{ pid }] } = await dono.query('select pg_backend_pid() as pid');
  const mudanca = dono.query(ALTERAR, [alvo.org, alvo.b, alvo.conversa, 'assumir', 1, null]);
  const bloqueio = await observarBloqueioNoPostgres(admin, pid);
  await worker.query('commit');
  const { rows: [resultado] } = await mudanca;
  const estado = await estadoDoEnvio(admin, alvo.evento);
  if (inicio !== 'iniciado' || !bloqueio.observado || resultado.resultado !== 'aplicado'
      || resultado.em_voo !== 1 || estado.status !== 'in_flight') {
    return err('EmVooInvisivel', 'o takeover não viu a resposta em voo', { inicio, bloqueio, resultado, estado });
  }
  return ok({ resumo: `início segura o controle: o takeover esperou (wait_event=${bloqueio.waitEvent}) e informou 1 resposta em voo` });
}

async function corridasSoltas({ admin, novoCliente }) {
  const [worker, dono] = [await novoCliente(), await novoCliente()];
  const contagem = { invalidados: 0, emVoo: 0 };
  for (let i = 0; i < 20; i++) {
    const alvo = await envioReivindicado(admin, worker, `solta-${i}`);
    const [{ rows: [{ inicio }] }, { rows: [mudanca] }] = await Promise.all([
      worker.query(INICIAR, [alvo.evento, alvo.worker, alvo.token]),
      dono.query(ALTERAR, [alvo.org, alvo.b, alvo.conversa, 'assumir', 1, null]),
    ]);
    const estado = await estadoDoEnvio(admin, alvo.evento);
    const invalidado = inicio === 'invalidado' && estado.status === 'dead_letter' && estado.tentativas === 0 && mudanca.em_voo === 0;
    const emVooContado = inicio === 'iniciado' && estado.status === 'in_flight' && mudanca.em_voo === 1;
    if (mudanca.resultado !== 'aplicado' || !(invalidado || emVooContado)) {
      return err('CorridaSemDono', 'envio saiu sem o takeover saber', { i, inicio, mudanca, estado });
    }
    contagem[invalidado ? 'invalidados' : 'emVoo']++;
  }
  return ok({ resumo: `20 corridas soltas: ${contagem.invalidados} invalidados, ${contagem.emVoo} em voo contados; nenhum invisível` });
}

/**
 * Resposta que voltou à fila em `failed_transient` (o worker provou que não
 * enviou) contra um takeover e um novo claim simultâneos: ou o takeover a
 * cancela, ou o novo início a invalida, ou ela sai e o takeover a conta.
 */
async function failedTransientNaCorrida({ admin, novoCliente }) {
  const [worker, dono] = [await novoCliente(), await novoCliente()];
  const contagem = { cancelados: 0, invalidadosNoInicio: 0, emVoo: 0 };
  for (let i = 0; i < 20; i++) {
    const alvo = await envioReivindicado(admin, worker, `ft-${i}`);
    await worker.query("select * from public.concluir_envio_chatwoot($1, $2, $3, 'nao_enviado', null, null, 'recusou', 'transient', 1)",
      [alvo.evento, alvo.worker, alvo.token]);
    await admin.query("update public.outbox_eventos set next_retry_at = clock_timestamp() - interval '1 second' where id = $1", [alvo.evento]);
    const { rows: [{ fencing_token: tokenAntes }] } = await admin.query('select fencing_token from public.outbox_eventos where id = $1', [alvo.evento]);
    const reenvio = (async () => {
      const lote = (await worker.query(REIVINDICAR, [`w-ft2-${i}`])).rows.find((r) => r.evento_id === alvo.evento);
      if (!lote) return 'sem_claim';
      return (await worker.query(INICIAR, [alvo.evento, `w-ft2-${i}`, lote.fencing_token])).rows[0].inicio;
    })();
    const [inicio, { rows: [mudanca] }] = await Promise.all([
      reenvio,
      dono.query(ALTERAR, [alvo.org, alvo.b, alvo.conversa, 'assumir', 1, null]),
    ]);
    const estado = await estadoDoEnvio(admin, alvo.evento);
    const { rows: [{ fencing_token: tokenDepois, health_status: saude }] } = await admin.query(
      `select o.fencing_token, c.health_status from public.outbox_eventos o
         join public.conexoes_integracao c on c.id = o.conexao_id where o.id = $1`, [alvo.evento]);
    const cancelado = inicio === 'sem_claim' && mudanca.invalidados === 1 && estado.status === 'dead_letter'
      && estado.invalidado && Number(tokenDepois) > Number(tokenAntes);
    const invalidadoNoInicio = inicio === 'invalidado' && mudanca.invalidados === 0 && estado.status === 'dead_letter';
    const emVoo = inicio === 'iniciado' && mudanca.em_voo === 1 && estado.status === 'in_flight';
    if (mudanca.resultado !== 'aplicado' || saude !== 'degraded' || !(cancelado || invalidadoNoInicio || emVoo)) {
      return err('FailedTransientEscapou', 'resposta em failed_transient escapou do takeover', { i, inicio, mudanca, estado, saude });
    }
    contagem[cancelado ? 'cancelados' : invalidadoNoInicio ? 'invalidadosNoInicio' : 'emVoo']++;
  }
  return ok({
    resumo: `20 corridas com failed_transient: ${contagem.cancelados} cancelados pelo takeover, `
      + `${contagem.invalidadosNoInicio} invalidados no início, ${contagem.emVoo} em voo contados; saúde intacta`,
  });
}

async function contraprovaSemConferirVersao({ admin, novoCliente }) {
  const cliente = await novoCliente();
  const alvo = await envioReivindicado(admin, cliente, 'contraprova');
  await cliente.query(ALTERAR, [alvo.org, alvo.b, alvo.conversa, 'assumir', 1, null]);
  await admin.query('begin');
  let resultado;
  try {
    // Sabotagem: iniciar sem conferir o controle.
    await admin.query(`
      create or replace function public.iniciar_envio_chatwoot(p_evento_id uuid, p_worker_id text, p_fencing_token bigint)
      returns text language sql security definer set search_path = '' as $$
        update public.outbox_eventos set status = 'in_flight', despachado_em = now(), updated_at = now()
         where id = p_evento_id and status = 'processing' and lease_owner = p_worker_id
           and fencing_token = p_fencing_token and lease_expires_at >= now()
        returning 'iniciado'::text;
      $$`);
    ({ rows: [{ inicio: resultado }] } = await admin.query(INICIAR, [alvo.evento, alvo.worker, alvo.token]));
  } finally {
    await admin.query('rollback');
  }
  if (resultado !== 'iniciado') return err('ContraprovaNaoDetectou', 'sem a conferência, o envio deveria sair', { resultado });
  const { rows: [{ inicio }] } = await cliente.query(INICIAR, [alvo.evento, alvo.worker, alvo.token]);
  if (inicio !== 'invalidado') return err('SabotagemVazou', 'a sabotagem não foi revertida', { inicio });
  return ok({ resumo: 'contraprova: sem conferir a versão, a resposta de quem perdeu a conversa sairia; revertida' });
}

/**
 * @returns {Promise<object>} Resultado tagueado do rehearsal.
 */
export async function runControleChatwootRaceRehearsal() {
  const abertos = [];
  const novoCliente = async () => {
    const client = createLocalDatabaseClient('orbita-controle-chatwoot');
    client.on('error', () => {});
    await client.connect();
    await client.query('set role service_role');
    await client.query("set request.jwt.claim.role = 'service_role'");
    abertos.push(client);
    return client;
  };
  const admin = createLocalDatabaseClient('orbita-controle-chatwoot-admin');
  try {
    await admin.connect();
    await admin.query("update public.inbox_eventos_chatwoot set available_at = 'infinity' where status in ('received', 'failed')");
    const pool = await Promise.all(Array.from({ length: 8 }, novoCliente));
    const ctx = { admin, pool, novoCliente };
    const resumos = [];
    for (const etapa of [abasConcorrentes, takeoverPrimeiro, inicioPrimeiro, corridasSoltas, failedTransientNaCorrida,
      contraprovaSemConferirVersao]) {
      const resultado = await etapa(ctx);
      if (resultado._tag === 'err') return resultado;
      resumos.push(resultado.value.resumo);
    }
    return ok(Object.freeze({ relato: `controle do atendimento (MSG-009) provado no Postgres: ${resumos.join('; ')}` }));
  } catch (cause) {
    return err('ControleChatwootRehearsalFailed', 'Falha inesperada no rehearsal do controle do atendimento', {}, cause);
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
