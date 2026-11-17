import { err, ok } from './script-result.mjs';
import {
  aceitar,
  aplicar,
  casosDe,
  comandoDaMensagem,
  linhaDo,
  novaOrganizacao,
  reivindicar,
  vencerLease,
} from './database-concurrency-consumidor-inbox-apoio.mjs';

/**
 * MSG-006: contraprovas do consumidor, por sabotagem medida e revertida. Sem lease, sem
 * fencing, sem a transação única e sem a guarda de idempotência: cada uma tem de
 * produzir o defeito, senão a prova do ensaio não vale nada.
 */

/** Troca a função por uma versão sabotada e devolve como restaurar. */
async function sabotar(admin, assinatura, trechos) {
  const { rows: [{ definicao }] } = await admin.query('select pg_get_functiondef($1::regprocedure) as definicao', [assinatura]);
  let sabotada = definicao;
  for (const [de, para] of trechos) {
    if (!sabotada.includes(de)) throw new Error(`Trecho da sabotagem não encontrado: ${de.slice(0, 60)}`);
    sabotada = sabotada.replace(de, para);
  }
  await admin.query(sabotada);
  return async () => {
    await admin.query(definicao);
  };
}

// A lógica da aplicação vive na função base; o nome público é o invólucro da 94
// que marca a transação da inbox para o avanço de versão do caso.
const APLICAR_SIG = 'public.aplicar_evento_inbox_chatwoot_base_msg013(uuid,text,bigint,jsonb)';
const CLAIM_SIG = 'public.reivindicar_eventos_inbox_chatwoot(text,integer,integer,timestamptz)';

export async function contraprovaSemFencing({ admin, clientA, clientB }) {
  const { org, conexao } = await novaOrganizacao(admin, 'cpf');
  const { evento_id: evento } = await aceitar(clientA, org, conexao, 'v2:message_created:msg:5000');
  const [antigo] = await reivindicar(clientA, 'w-velho');
  await vencerLease(admin, evento);
  const [novo] = await reivindicar(clientB, 'w-novo');
  const restaurar = await sabotar(admin, APLICAR_SIG, [[
    `or v_evento.lease_owner is distinct from p_worker
       or v_evento.fencing_token <> p_fencing_token
       or v_evento.lease_expires_at is null
       or v_evento.lease_expires_at <= clock_timestamp()`, '']]);
  try {
    const cercado = await aplicar(clientA, evento, 'w-velho', antigo.fencing_token, comandoDaMensagem(5000, 500, 90));
    if (cercado.desfecho !== 'aplicado') {
      return err('ContraprovaSemFencingNaoMordeu', 'Sem fencing o token velho deveria aplicar', { cercado, novo: novo.fencing_token });
    }
    return ok({ resumo: `sem fencing: o token ${antigo.fencing_token} aplicou com o token ${novo.fencing_token} vigente` });
  } finally {
    await restaurar();
  }
}

export async function contraprovaSemLease({ admin, clientA, clientB }) {
  const { org, conexao } = await novaOrganizacao(admin, 'cpl');
  const { evento_id: evento } = await aceitar(clientA, org, conexao, 'v2:message_created:msg:5100');
  const restaurar = await sabotar(admin, CLAIM_SIG, [[
    "(e.status = 'processing' and coalesce(e.lease_expires_at, '-infinity'::timestamptz) <= v_agora)",
    "e.status = 'processing'"]]);
  try {
    const [primeiro] = await reivindicar(clientA, 'w-1');
    const segundo = (await reivindicar(clientB, 'w-2')).find((e) => e.evento_id === evento);
    if (primeiro?.evento_id !== evento || !segundo) {
      return err('ContraprovaSemLeaseNaoMordeu', 'Sem lease dois workers deveriam pegar o evento', { segundo: Boolean(segundo) });
    }
    await admin.query("update public.inbox_eventos_chatwoot set status = 'failed', disposicao = 'falha_definitiva' where id = $1", [evento]);
    return ok({ resumo: 'sem lease: dois workers reivindicam o mesmo evento vivo' });
  } finally {
    await restaurar();
  }
}

/**
 * A sequência em chamadas separadas (o que o webhook fazia e o que a RPC única
 * evita): cai antes da conclusão e o caso fica sem a inbox concluída.
 */
export async function contraprovaSemTransacaoUnica({ admin, clientA }) {
  const { org, conexao } = await novaOrganizacao(admin, 'cpt');
  const { evento_id: evento } = await aceitar(clientA, org, conexao, 'v2:message_created:msg:5200');
  await reivindicar(clientA, 'w-seq');
  const { rows: [contato] } = await admin.query(
    `insert into public.chatwoot_contacts (id, id_externo, organizacao_id, conexao_id, name)
     values (91, '91', $1, $2, 'Sintetico') returning id_local`, [org, conexao]);
  const { rows: [conversa] } = await admin.query(
    `insert into public.chatwoot_conversations (id, id_externo, organizacao_id, conexao_id, contato_id_local, contact_id, status)
     values (510, '510', $1, $2, $3, 91, 'open') returning id_local`, [org, conexao, contato.id_local]);
  await admin.query('insert into public.sac_cases (organizacao_id, conversa_id_local, evento_origem_id) values ($1, $2, $3)',
    [org, conversa.id_local, evento]);
  // Queda aqui: sem a conclusão nem a auditoria.
  const linha = await linhaDo(admin, evento);
  const { rows: [{ auditoria }] } = await admin.query(
    "select count(*)::int as auditoria from public.eventos_auditoria_sistema where acao = 'sac.case_opened' and organizacao_id = $1", [org]);
  if (await casosDe(admin, org) !== 1 || linha.status !== 'processing' || auditoria !== 0) {
    return err('ContraprovaSemTransacaoNaoMordeu', 'A sequência separada deveria deixar estado parcial', { linha, auditoria });
  }
  return ok({ resumo: 'sem a transação única: caso existe com a inbox em processing e sem auditoria' });
}

export async function contraprovaSemIdempotencia({ admin, clientA, clientB }) {
  const { org, conexao } = await novaOrganizacao(admin, 'cpi');
  const consumir = async (client, worker, chave, mensagem) => {
    const { evento_id: evento } = await aceitar(client, org, conexao, chave);
    const lote = await reivindicar(client, worker);
    const alvo = lote.find((e) => e.evento_id === evento);
    return aplicar(client, evento, worker, alvo.fencing_token, comandoDaMensagem(mensagem, 520, 92));
  };
  const semBusca = await sabotar(admin, APLICAR_SIG, [[
    `and (s.mensagem_origem_id_local = v_mensagem_local
                    or (s.conversa_id_local = v_conversa_local and s.phase not in ('RESOLVED', 'CLOSED', 'CANCELLED')))`,
    'and false']]);
  const { rows: indices } = await admin.query(
    `select indexname, indexdef from pg_indexes where schemaname = 'public'
      and indexname in ('uq_sac_cases_conversa_aberto', 'uq_sac_cases_mensagem_origem')`);
  let semIndice;
  let comIndice;
  try {
    // Com os índices, a função sem a busca bate no único: o banco é a última guarda.
    await consumir(clientA, 'w-1', 'v2:message_created:msg:5300', 5300);
    try {
      await consumir(clientB, 'w-2', 'legada:msg:5300', 5300);
    } catch (cause) {
      comIndice = cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : 'desconhecido';
    }
    for (const { indexname } of indices) await admin.query(`drop index public.${indexname}`);
    await admin.query("update public.inbox_eventos_chatwoot set lease_expires_at = clock_timestamp() - interval '1 second' where organizacao_id = $1 and status = 'processing'", [org]);
    await consumir(clientB, 'w-3', 'legada-2:msg:5300', 5300);
    semIndice = await casosDe(admin, org);
    await admin.query('delete from public.sac_cases where organizacao_id = $1', [org]);
  } finally {
    await semBusca();
    for (const { indexname, indexdef } of indices) {
      const { rows } = await admin.query('select to_regclass($1) as existe', [`public.${indexname}`]);
      if (rows[0].existe === null) await admin.query(indexdef);
    }
  }
  if (comIndice !== '23505' || semIndice !== 2) {
    return err('ContraprovaSemIdempotenciaNaoMordeu', 'Sem as guardas a mesma mensagem deveria abrir dois casos', { comIndice, semIndice });
  }
  return ok({ resumo: 'sem a busca, o único barra com 23505; sem a busca e sem os únicos, a mesma mensagem abre 2 casos' });
}
