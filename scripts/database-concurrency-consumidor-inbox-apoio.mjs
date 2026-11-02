/** MSG-006: chamadas e leituras comuns ao ensaio do consumidor e às suas contraprovas. */

const ACEITAR = `select * from public.aceitar_entrega_inbox_chatwoot($1, $2, null, 1, null, $3, $4, '{"event":"x"}'::jsonb)`;
const REIVINDICAR = "select * from public.reivindicar_eventos_inbox_chatwoot($1, $2, $3, 'epoch'::timestamptz)";
const APLICAR = 'select * from public.aplicar_evento_inbox_chatwoot($1, $2, $3, $4::jsonb)';

export function comandoDaMensagem(mensagem, conversa, contato, extra = {}) {
  return {
    evento: 'message_created',
    acao: 'espelhar',
    account_id: '1',
    abre_caso: true,
    contato: { id: contato, nome: `Sintetico ${contato}` },
    conversa: { id: conversa, contato_id: contato, status: 'open', inbox_id: 1, canal: 'Channel::Api' },
    mensagem: { id: mensagem, conversa_id: conversa, conteudo: 'sintetico', tipo: 'incoming', remetente_tipo: 'contact', modo: 'preservar' },
    ...extra,
  };
}

export async function aceitar(client, org, conexao, chave, tipo = 'message_created') {
  return (await client.query(ACEITAR, [org, conexao, chave, tipo])).rows[0];
}

export async function reivindicar(client, worker, limite = 50, lease = 60) {
  return (await client.query(REIVINDICAR, [worker, limite, lease])).rows;
}

export async function aplicar(client, eventoId, worker, token, comando) {
  return (await client.query(APLICAR, [eventoId, worker, token, JSON.stringify(comando)])).rows[0];
}

export async function casosDe(admin, org) {
  return (await admin.query('select count(*)::int as n from public.sac_cases where organizacao_id = $1', [org])).rows[0].n;
}

export async function linhaDo(admin, eventoId) {
  return (await admin.query(
    'select status, disposicao, attempts, fencing_token::int as token, lease_owner, caso_id from public.inbox_eventos_chatwoot where id = $1',
    [eventoId])).rows[0];
}

export async function vencerLease(admin, eventoId) {
  await admin.query("update public.inbox_eventos_chatwoot set lease_expires_at = clock_timestamp() - interval '1 second' where id = $1", [eventoId]);
}

/** Cada etapa usa uma organização própria: conta só o que ela mesma fez. */
export async function novaOrganizacao(admin, sufixo) {
  const { rows: [{ org, conexao }] } = await admin.query('select gen_random_uuid() as org, gen_random_uuid() as conexao');
  await admin.query("insert into public.organizacoes (id, nome, slug, status) values ($1, $2, $3, 'active')", [org, `M6 ${sufixo}`, `m6-${sufixo}-${org.slice(0, 8)}`]);
  await admin.query("insert into public.conexoes_integracao (id, organizacao_id, provedor, nome, status) values ($1, $2, 'chatwoot', $3, 'conectado')", [conexao, org, sufixo]);
  return { org, conexao };
}
