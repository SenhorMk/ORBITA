import { createLocalDatabaseClient } from './local-database-client.mjs';
import { err, ok } from './script-result.mjs';
import { aceitar, aplicar, comandoDaMensagem, novaOrganizacao, reivindicar } from './database-concurrency-consumidor-inbox-apoio.mjs';

/**
 * MSG-008. Prova contra Postgres real, como `service_role`, o envio ao Chatwoot
 * por intenção (`registrar_envio_chatwoot`, `reivindicar_envios_chatwoot`,
 * `concluir_envio_chatwoot`):
 *
 * 1. oito pedidos simultâneos do mesmo comando e mesmo texto: uma intenção, um evento;
 * 2. oito pedidos simultâneos do mesmo comando com textos diferentes: um registra, sete conflitam;
 * 3. queda antes do commit do registro: nenhuma intenção, nenhum evento;
 * 4. oito workers em 40 envios: cada envio reivindicado uma vez, token 1;
 * 5. worker morto depois de iniciar o despacho: o reaper leva a `unknown`, e nada é reivindicado de novo;
 * 6. zumbi: o recibo do worker que perdeu a lease não confirma nem cria mensagem;
 * 7. duas conexões da mesma organização e outra organização, com o mesmo id remoto, em paralelo.
 *
 * Contraprova medida e revertida: sem o filtro de intenção no claim, o backlog do
 * envio inline seria reivindicado.
 */

const WORKERS = 8;
const REGISTRAR = 'select * from public.registrar_envio_chatwoot($1, $2, $3, $4, $5)';
const REIVINDICAR = "select * from public.reivindicar_envios_chatwoot($1, $2, 60, 'epoch'::timestamptz, 2)";

async function novaConversa(admin, cliente, sufixo, conversaRemota = 50) {
  const { org, conexao } = await novaOrganizacao(admin, `m8-${sufixo}`);
  const { rows: [{ ator }] } = await admin.query('select gen_random_uuid() as ator');
  await admin.query("insert into auth.users (id, email) values ($1, $2)", [ator, `m8-${sufixo}-${ator.slice(0, 8)}@orbita.test`]);
  await admin.query("insert into public.membros_organizacao (organizacao_id, user_id, papel) values ($1, $2, 'member')", [org, ator]);
  return { org, ator, ...(await conversaNaConexao(admin, cliente, org, conexao, sufixo, conversaRemota)) };
}

/** A conversa nasce pelo consumo real da inbox (MSG-006). */
async function conversaNaConexao(admin, cliente, org, conexao, sufixo, conversaRemota) {
  const evento = await aceitar(cliente, org, conexao, `m8-${sufixo}-${conexao}`);
  const lote = await reivindicar(cliente, `m8-inbox-${sufixo}`);
  const meu = lote.find((linha) => linha.evento_id === evento.evento_id);
  await aplicar(cliente, meu.evento_id, `m8-inbox-${sufixo}`, meu.fencing_token, comandoDaMensagem(9000, conversaRemota, 5));
  const { rows: [{ conversa }] } = await admin.query(
    'select id_local as conversa from public.chatwoot_conversations where conexao_id = $1 and id_externo = $2', [conexao, String(conversaRemota)]);
  return { conexao, conversa };
}

async function contar(admin, org) {
  const { rows: [linha] } = await admin.query(
    `select (select count(*)::int from public.chatwoot_envios where organizacao_id = $1) as envios,
            (select count(*)::int from public.outbox_eventos where organizacao_id = $1 and destination = 'chatwoot') as eventos`, [org]);
  return linha;
}

async function registroConcorrente({ admin, pool }) {
  const alvo = await novaConversa(admin, pool[0], 'dup');
  const { rows: [{ comando }] } = await admin.query('select gen_random_uuid() as comando');
  const resultados = await Promise.all(pool.map(async (client) =>
    (await client.query(REGISTRAR, [alvo.org, alvo.ator, alvo.conversa, comando, 'mesmo texto'])).rows[0]));
  const registrados = resultados.filter((r) => r.resultado === 'registrado').length;
  const existentes = resultados.filter((r) => r.resultado === 'existente').length;
  const ids = new Set(resultados.map((r) => r.envio_id));
  const { envios, eventos } = await contar(admin, alvo.org);
  if (registrados !== 1 || existentes !== WORKERS - 1 || ids.size !== 1 || envios !== 1 || eventos !== 1) {
    return err('RegistroDuplicado', 'pedidos simultâneos criaram mais de uma intenção', { registrados, existentes, envios, eventos });
  }
  return ok({ resumo: `8 pedidos simultâneos do mesmo comando: 1 registrado, 7 existentes, 1 intenção, 1 evento` });
}

async function conflitoConcorrente({ admin, pool }) {
  const alvo = await novaConversa(admin, pool[0], 'conflito');
  const { rows: [{ comando }] } = await admin.query('select gen_random_uuid() as comando');
  const resultados = await Promise.all(pool.map(async (client, i) =>
    (await client.query(REGISTRAR, [alvo.org, alvo.ator, alvo.conversa, comando, `texto ${i}`])).rows[0]));
  const registrados = resultados.filter((r) => r.resultado === 'registrado').length;
  const conflitos = resultados.filter((r) => r.resultado === 'conflito').length;
  const { envios, eventos } = await contar(admin, alvo.org);
  if (registrados !== 1 || conflitos !== WORKERS - 1 || envios !== 1 || eventos !== 1) {
    return err('ConflitoNaoDetectado', 'textos diferentes no mesmo comando passaram', { registrados, conflitos, envios, eventos });
  }
  return ok({ resumo: `mesmo comando com 8 textos: 1 registrado, 7 conflitos, nada a mais gravado` });
}

async function quedaAntesDoCommit({ admin, pool, novoCliente }) {
  const alvo = await novaConversa(admin, pool[0], 'queda');
  const vitima = await novoCliente();
  await vitima.query('begin');
  const { rows: [registro] } = await vitima.query(REGISTRAR, [alvo.org, alvo.ator, alvo.conversa, alvo.org, 'antes do commit']);
  const { rows: [{ pid }] } = await vitima.query('select pg_backend_pid() as pid');
  await admin.query('select pg_terminate_backend($1)', [pid]);
  const { envios, eventos } = await contar(admin, alvo.org);
  if (registro.resultado !== 'registrado' || envios !== 0 || eventos !== 0) {
    return err('RegistroParcial', 'a queda antes do commit deixou rastro', { envios, eventos });
  }
  return ok({ resumo: 'queda antes do commit do registro: 0 intenções, 0 eventos' });
}

async function workersConcorrentes({ admin, pool }) {
  const alvo = await novaConversa(admin, pool[0], 'lote');
  const total = 40;
  for (let i = 0; i < total; i++) {
    await pool[0].query('select * from public.registrar_envio_chatwoot($1, $2, $3, gen_random_uuid(), $4)',
      [alvo.org, alvo.ator, alvo.conversa, `lote ${i}`]);
  }
  const reivindicados = [];
  await Promise.all(pool.map(async (client, i) => {
    for (;;) {
      const lote = (await client.query(REIVINDICAR, [`w-lote-${i}`, 3])).rows.filter((r) => r.organizacao_id === alvo.org);
      if (lote.length === 0) return;
      reivindicados.push(...lote.map((r) => ({ id: r.evento_id, token: Number(r.fencing_token) })));
    }
  }));
  const unicos = new Set(reivindicados.map((r) => r.id));
  if (reivindicados.length !== total || unicos.size !== total || reivindicados.some((r) => r.token !== 1)) {
    return err('ClaimDuplicado', 'algum envio foi reivindicado duas vezes', { reivindicados: reivindicados.length, unicos: unicos.size });
  }
  return ok({ resumo: `8 workers em ${total} envios: ${unicos.size} reivindicados uma vez cada, token 1` });
}

async function quedaDepoisDoDespacho({ admin, pool, novoCliente }) {
  const alvo = await novaConversa(admin, pool[0], 'voo');
  const { rows: [registro] } = await pool[0].query(REGISTRAR, [alvo.org, alvo.ator, alvo.conversa, alvo.org, 'em voo']);
  const worker = await novoCliente();
  const lote = (await worker.query(REIVINDICAR, ['w-voo', 50])).rows.find((r) => r.evento_id === registro.evento_id);
  await worker.query('select public.iniciar_despacho_outbox($1, $2, $3)', [registro.evento_id, 'w-voo', lote.fencing_token]);
  // O POST saiu; o processo morre antes de gravar o recibo.
  const { rows: [{ pid }] } = await worker.query('select pg_backend_pid() as pid');
  await admin.query('select pg_terminate_backend($1)', [pid]);
  await admin.query("update public.outbox_eventos set lease_expires_at = clock_timestamp() - interval '1 second' where id = $1", [registro.evento_id]);
  await pool[1].query('select * from public.liberar_leases_expirados_outbox()');
  const { rows: [linha] } = await admin.query('select status, motivo_bloqueio from public.outbox_eventos where id = $1', [registro.evento_id]);
  const denovo = (await pool[2].query(REIVINDICAR, ['w-depois', 50])).rows.filter((r) => r.evento_id === registro.evento_id);
  if (linha.status !== 'unknown' || linha.motivo_bloqueio !== 'lease_expirada_em_voo' || denovo.length !== 0) {
    return err('EnvioEmVooRepetivel', 'despacho em voo voltou à fila', { linha, denovo: denovo.length });
  }
  return ok({ resumo: 'worker morto com o despacho em voo: unknown (lease_expirada_em_voo), nunca reivindicado de novo' });
}

async function zumbi({ admin, pool }) {
  const alvo = await novaConversa(admin, pool[0], 'zumbi');
  const { rows: [registro] } = await pool[0].query(REGISTRAR, [alvo.org, alvo.ator, alvo.conversa, alvo.org, 'zumbi']);
  const lote = (await pool[1].query(REIVINDICAR, ['w-zumbi', 50])).rows.find((r) => r.evento_id === registro.evento_id);
  await pool[1].query('select public.iniciar_despacho_outbox($1, $2, $3)', [registro.evento_id, 'w-zumbi', lote.fencing_token]);
  await admin.query("update public.outbox_eventos set lease_expires_at = clock_timestamp() - interval '1 second' where id = $1", [registro.evento_id]);
  const { rows: [conclusao] } = await pool[1].query(
    "select * from public.concluir_envio_chatwoot($1, 'w-zumbi', $2, 'confirmado', '880001')", [registro.evento_id, lote.fencing_token]);
  const { rows: [{ mensagens }] } = await admin.query(
    "select count(*)::int as mensagens from public.chatwoot_messages where conexao_id = $1 and id_externo = '880001'", [alvo.conexao]);
  if (conclusao.status !== null || mensagens !== 0) {
    return err('ZumbiConfirmou', 'recibo sem posse confirmou', { conclusao, mensagens });
  }
  return ok({ resumo: 'recibo do worker sem lease: recusado pelo fencing, nenhuma mensagem' });
}

async function conexoesEOrganizacoes({ admin, pool }) {
  const a1 = await novaConversa(admin, pool[0], 'iso-a');
  const { rows: [{ conexao: a2Conexao }] } = await admin.query('select gen_random_uuid() as conexao');
  await admin.query("insert into public.conexoes_integracao (id, organizacao_id, provedor, nome, status) values ($1, $2, 'chatwoot', 'A2', 'conectado')", [a2Conexao, a1.org]);
  const a2 = await conversaNaConexao(admin, pool[0], a1.org, a2Conexao, 'iso-a2', 50);
  const b = await novaConversa(admin, pool[0], 'iso-b');
  const alvos = [
    { org: a1.org, ator: a1.ator, conversa: a1.conversa, conexao: a1.conexao },
    { org: a1.org, ator: a1.ator, conversa: a2.conversa, conexao: a2Conexao },
    { org: b.org, ator: b.ator, conversa: b.conversa, conexao: b.conexao },
  ];
  await Promise.all(alvos.map((alvo, i) => pool[i].query(REGISTRAR, [alvo.org, alvo.ator, alvo.conversa, b.org, 'mesmo comando, mesmo id remoto'])));
  const { rows } = await admin.query(
    `select e.organizacao_id, e.conexao_id, c.id_externo from public.chatwoot_envios e
       join public.chatwoot_conversations c on c.id_local = e.conversa_id_local
      where e.command_id = $1 order by e.created_at`, [b.org]);
  const certo = rows.length === 2 && rows.every((r) => r.id_externo === '50')
    && rows.some((r) => r.organizacao_id === b.org && r.conexao_id === b.conexao);
  if (!certo) return err('IdentidadeMisturada', 'conexões ou organizações compartilharam a intenção', { rows });
  return ok({ resumo: 'A1, A2 e B com a conversa remota 50 e o mesmo comando: A registra uma vez (a 2ª é conflito), B independente' });
}

async function contraprovaSemFiltroDeIntencao({ admin }) {
  const { org, conexao } = await novaOrganizacao(admin, 'm8-legado');
  await admin.query(
    "select * from public.registrar_evento_outbox($1, $2, null, 'chatwoot_msg_inline_m8', 'chatwoot', 'message.send', '{}'::jsonb, 5)", [org, conexao]);
  await admin.query('begin');
  try {
    // Sabotagem: o claim sem o join com a intenção.
    await admin.query(`
      create or replace function public.reivindicar_envios_chatwoot(p_worker_id text, p_limit integer, p_lease_ttl_sec integer, p_criados_desde timestamptz, p_protocolo integer)
      returns table (evento_id uuid, organizacao_id uuid, conexao_id uuid, envio_id uuid, ator_id uuid, conversa_id_local uuid,
                     conversa_id_externo text, conteudo text, privada boolean, correlation_id text, fencing_token bigint, lease_expires_at timestamptz)
      language sql security definer set search_path = '' as $$
        update public.outbox_eventos o set status = 'processing', lease_owner = p_worker_id,
               lease_expires_at = now() + make_interval(secs => p_lease_ttl_sec)
         where o.destination = 'chatwoot' and o.event_type = 'message.send' and o.status = 'pending'
        returning o.id, o.organizacao_id, o.conexao_id, null::uuid, null::uuid, null::uuid, null::text, null::text, false,
                  o.correlation_id, o.fencing_token, o.lease_expires_at;
      $$`);
    const { rows } = await admin.query(REIVINDICAR, ['w-sabotado', 50]);
    const legado = rows.filter((r) => r.organizacao_id === org).length;
    if (legado !== 1) return err('ContraprovaNaoDetectou', 'sem o filtro, o backlog inline deveria ser reivindicado', { legado });
  } finally {
    await admin.query('rollback');
  }
  const { rows: [{ status }] } = await admin.query("select status from public.outbox_eventos where idempotency_key = 'chatwoot_msg_inline_m8'");
  if (status !== 'pending') return err('SabotagemVazou', 'a sabotagem não foi revertida', { status });
  return ok({ resumo: 'contraprova: sem o filtro de intenção, o backlog inline seria reivindicado (1/1); revertida' });
}

/**
 * @returns {Promise<object>} Resultado tagueado do rehearsal.
 */
export async function runEnvioChatwootRaceRehearsal() {
  const abertos = [];
  const novoCliente = async () => {
    const client = createLocalDatabaseClient('orbita-envio-chatwoot');
    client.on('error', () => {});
    await client.connect();
    await client.query('set role service_role');
    await client.query("set request.jwt.claim.role = 'service_role'");
    abertos.push(client);
    return client;
  };
  const admin = createLocalDatabaseClient('orbita-envio-chatwoot-admin');
  try {
    await admin.connect();
    // Eventos deixados por outros ensaios não entram nos consumos daqui.
    await admin.query("update public.inbox_eventos_chatwoot set available_at = 'infinity' where status in ('received', 'failed')");
    const pool = await Promise.all(Array.from({ length: WORKERS }, novoCliente));
    const ctx = { admin, pool, novoCliente };
    const resumos = [];
    for (const etapa of [
      registroConcorrente, conflitoConcorrente, quedaAntesDoCommit, workersConcorrentes,
      quedaDepoisDoDespacho, zumbi, conexoesEOrganizacoes, contraprovaSemFiltroDeIntencao,
    ]) {
      const resultado = await etapa(ctx);
      if (resultado._tag === 'err') return resultado;
      resumos.push(resultado.value.resumo);
    }
    return ok(Object.freeze({ relato: `envio ao Chatwoot (MSG-008) provado no Postgres: ${resumos.join('; ')}` }));
  } catch (cause) {
    return err('EnvioChatwootRehearsalFailed', 'Falha inesperada no rehearsal do envio ao Chatwoot', {}, cause);
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
