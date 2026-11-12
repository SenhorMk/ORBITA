import { createLocalDatabaseClient } from './local-database-client.mjs';
import { err, ok } from './script-result.mjs';
import { aceitar, aplicar, comandoDaMensagem, novaOrganizacao, reivindicar } from './database-concurrency-consumidor-inbox-apoio.mjs';

/**
 * MSG-010. Prova contra Postgres real, como `service_role`, que o vínculo do
 * cliente com a conversa não se duplica nem perde a conta sob concorrência:
 *
 * 1. oito confirmações simultâneas de clientes diferentes na mesma conversa:
 *    todas aplicam em fila e sobra uma única prova vigente;
 * 2. o mesmo comando enviado oito vezes: uma aplica, sete devolvem `existente`;
 * 3. vinte consultas simultâneas com número errado: cinco contam, quinze já
 *    encontram a consulta bloqueada, e o bloqueio é auditado uma vez.
 */

const CONFIRMAR = 'select * from public.confirmar_vinculo_cliente_sac($1, $2, $3, $4, $5)';
const CONSULTAR = 'select * from public.consultar_pedidos_do_cliente_verificado_sac($1, $2, $3)';

/** Conversa nova numa organização nova, com uma atendente e `quantos` clientes. */
async function novaConversa(admin, cliente, sufixo, quantos) {
  const { org, conexao } = await novaOrganizacao(admin, `m10-${sufixo}`);
  const { rows: [{ ator }] } = await admin.query('select gen_random_uuid() as ator');
  await admin.query('insert into auth.users (id, email) values ($1, $2)', [ator, `m10-${sufixo}-${ator.slice(0, 8)}@orbita.test`]);
  await admin.query("insert into public.membros_organizacao (organizacao_id, user_id, papel) values ($1, $2, 'member')", [org, ator]);
  const clientes = [];
  for (let i = 0; i < quantos; i += 1) {
    const { rows: [{ id }] } = await admin.query(
      'insert into public.clientes (organizacao_id, user_id, bling_id, nome) values ($1, $2, $3, $4) returning id',
      [org, ator, `m10-${sufixo}-${i}`, `Sintetico ${i}`]);
    clientes.push(id);
  }
  const evento = await aceitar(cliente, org, conexao, `m10-${sufixo}-${conexao}`);
  const lote = await reivindicar(cliente, `m10-inbox-${sufixo}`);
  const meu = lote.find((linha) => linha.evento_id === evento.evento_id);
  await aplicar(cliente, meu.evento_id, `m10-inbox-${sufixo}`, meu.fencing_token, comandoDaMensagem(9300, 60, 6));
  const { rows: [{ conversa }] } = await admin.query(
    "select id_local as conversa from public.chatwoot_conversations where conexao_id = $1 and id_externo = '60'", [conexao]);
  return { org, ator, conversa, clientes };
}

async function provas(admin, conversa) {
  const { rows: [linha] } = await admin.query(
    `select count(*)::int as total, count(*) filter (where revogado_em is null)::int as vigentes,
            count(*) filter (where revogacao_motivo = 'substituido')::int as substituidas
       from public.sac_vinculos_cliente where conversa_id_local = $1`, [conversa]);
  return linha;
}

async function confirmacoesSimultaneas({ admin, pool }) {
  const alvo = await novaConversa(admin, pool[0], 'confirmacoes', pool.length);
  const resultados = await Promise.all(pool.map(async (client, i) => {
    const { rows: [{ comando }] } = await client.query('select gen_random_uuid() as comando');
    return (await client.query(CONFIRMAR, [alvo.org, alvo.ator, alvo.conversa, comando, alvo.clientes[i]])).rows[0].resultado;
  }));
  const estado = await provas(admin, alvo.conversa);
  if (resultados.some((r) => r !== 'aplicado') || estado.total !== pool.length || estado.vigentes !== 1
      || estado.substituidas !== pool.length - 1) {
    return err('DuasProvasVigentes', 'confirmações simultâneas deixaram mais de uma prova vigente', { resultados, estado });
  }
  return ok({ resumo: `${pool.length} confirmações simultâneas: todas aplicaram em fila, 1 prova vigente e ${estado.substituidas} substituídas` });
}

async function mesmoComando({ admin, pool }) {
  const alvo = await novaConversa(admin, pool[0], 'repeticao', 1);
  const { rows: [{ comando }] } = await admin.query('select gen_random_uuid() as comando');
  const resultados = await Promise.all(pool.map(async (client) =>
    (await client.query(CONFIRMAR, [alvo.org, alvo.ator, alvo.conversa, comando, alvo.clientes[0]])).rows[0].resultado));
  const aplicados = resultados.filter((r) => r === 'aplicado').length;
  const existentes = resultados.filter((r) => r === 'existente').length;
  const estado = await provas(admin, alvo.conversa);
  if (aplicados !== 1 || existentes !== pool.length - 1 || estado.total !== 1) {
    return err('ComandoRepetidoGravou', 'o mesmo comando gravou mais de uma prova', { resultados, estado });
  }
  return ok({ resumo: `mesmo comando ${pool.length} vezes: 1 aplicou, ${existentes} existente, 1 prova` });
}

async function tentativasSimultaneas({ admin, pool, novoCliente }) {
  const alvo = await novaConversa(admin, pool[0], 'tentativas', 1);
  const { rows: [{ comando }] } = await admin.query('select gen_random_uuid() as comando');
  await pool[0].query(CONFIRMAR, [alvo.org, alvo.ator, alvo.conversa, comando, alvo.clientes[0]]);
  const clientes = [...pool, ...await Promise.all(Array.from({ length: 12 }, novoCliente))];
  const resultados = await Promise.all(clientes.map(async (client, i) =>
    (await client.query(CONSULTAR, [alvo.org, alvo.conversa, `errado-${i}`])).rows[0].resultado));
  const recusadas = resultados.filter((r) => r === 'nao_encontrado').length;
  const bloqueadas = resultados.filter((r) => r === 'bloqueada').length;
  const { rows: [conta] } = await admin.query(
    `select (select count(*)::int from public.sac_consultas_recusadas where conversa_id_local = $1) as recusas,
            (select count(*)::int from public.eventos_auditoria_sistema
              where acao = 'sac.order_lookup_blocked' and metadata ->> 'conversa_id_local' = $1::text) as auditorias`,
    [alvo.conversa]);
  if (recusadas !== 5 || bloqueadas !== clientes.length - 5 || conta.recusas !== 5 || conta.auditorias !== 1) {
    return err('BloqueioFurado', 'tentativas simultâneas passaram do limite', { recusadas, bloqueadas, conta });
  }
  return ok({ resumo: `${clientes.length} consultas simultâneas com número errado: 5 contadas, ${bloqueadas} bloqueadas, 1 auditoria` });
}

/**
 * @returns {Promise<object>} Resultado tagueado do rehearsal.
 */
export async function runVinculoClienteRaceRehearsal() {
  const abertos = [];
  const novoCliente = async () => {
    const client = createLocalDatabaseClient('orbita-vinculo-cliente');
    client.on('error', () => {});
    await client.connect();
    await client.query('set role service_role');
    await client.query("set request.jwt.claim.role = 'service_role'");
    abertos.push(client);
    return client;
  };
  const admin = createLocalDatabaseClient('orbita-vinculo-cliente-admin');
  try {
    await admin.connect();
    await admin.query("update public.inbox_eventos_chatwoot set available_at = 'infinity' where status in ('received', 'failed')");
    const pool = await Promise.all(Array.from({ length: 8 }, novoCliente));
    const ctx = { admin, pool, novoCliente };
    const resumos = [];
    for (const etapa of [confirmacoesSimultaneas, mesmoComando, tentativasSimultaneas]) {
      const resultado = await etapa(ctx);
      if (resultado._tag === 'err') return resultado;
      resumos.push(resultado.value.resumo);
    }
    return ok(Object.freeze({ relato: `vínculo do cliente (MSG-010) provado no Postgres: ${resumos.join('; ')}` }));
  } catch (cause) {
    return err('VinculoClienteRehearsalFailed', 'Falha inesperada no rehearsal do vínculo do cliente', {}, cause);
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
