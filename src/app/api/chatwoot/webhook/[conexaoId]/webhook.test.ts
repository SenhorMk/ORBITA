import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project-ref.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'public-key-12345678901234567890';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'server-key-12345678901234567890';
process.env.ENCRYPTION_KEY = 'ab'.repeat(32);

import { encrypt } from '@/lib/crypto';
const ORG_A = '22222222-2222-4222-8222-222222222222';
const ORG_B = '33333333-3333-4333-8333-333333333333';
const CONEXAO_A = '11111111-1111-4111-8111-111111111111';
const CONEXAO_B = '44444444-4444-4444-8444-444444444444';
/** Organização cujo owner perdeu o acesso: nenhuma membership de owner resolve. */
const ORG_SEM_DONO = '55555555-5555-4555-8555-555555555555';
const CONEXAO_SEM_DONO = '66666666-6666-4666-8666-666666666666';
const SECRET_SEM_DONO = 'chatwoot_secret_org_sem_dono_1234';
const OWNER_A = '70000000-0000-4000-8000-000000000001';
const OWNER_B = '70000000-0000-4000-8000-000000000002';
const SECRET_A = 'chatwoot_secret_org_a_1234567890';
const SECRET_B = 'chatwoot_secret_org_b_1234567890';

let connections: Record<string, { organizacao_id: string; status: string }> = {};
let credentials: Record<string, string> = {};
const inboxLookups: Array<{ conexao_id: string; inbox_id: number; organizacao_id: string }> = [];
const insertedInboxRows: unknown[] = [];
const mockUpsert = vi.fn().mockResolvedValue({ error: null });
const mockUpdate = vi.fn().mockReturnValue({
  eq: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
});

let mockInboxRegisterResult = {
  evento_id: 'evt-1',
  status: 'received',
  is_duplicate: false,
  cached_response: null as Record<string, unknown> | null,
};

/** Desfecho do contador de limite por conexão; `null` simula o store fora do ar. */
let limitePermite: boolean | null = true;

/**
 * Inbox fiel (MSG-005): mesma regra da função `aceitar_entrega_inbox_chatwoot`
 * — evento único por conexão + chave, entrega única por conexão + delivery id,
 * delivery id reaproveitado com outra chave recusado sem gravar nada.
 */
const inboxFiel = {
  ligada: false,
  falha: null as { code: string; message: string } | null,
  eventos: new Map<string, { id: string; chave: string; status: string; response_body: Record<string, unknown> | null }>(),
  entregas: new Map<string, string>(),
  aceitar(args: Record<string, unknown>) {
    if (this.falha) return { data: null, error: this.falha };
    const conexao = String(args.p_conexao_id);
    const chave = String(args.p_idempotency_key);
    const existente = this.eventos.get(`${conexao}|${chave}`);
    let duplicata: 'entrega' | 'evento' | null = existente ? 'evento' : null;
    if (args.p_delivery_id) {
      const anterior = this.entregas.get(`${conexao}|${String(args.p_delivery_id)}`);
      if (anterior !== undefined && anterior !== chave) return { data: null, error: { code: '23505', message: 'reutilizado' } };
      if (anterior !== undefined) duplicata = 'entrega';
      this.entregas.set(`${conexao}|${String(args.p_delivery_id)}`, chave);
    }
    const evento = existente ?? { id: `evt-fiel-${this.eventos.size + 1}`, chave, status: 'received', response_body: null };
    this.eventos.set(`${conexao}|${chave}`, evento);
    return {
      data: [{ evento_id: evento.id, status: evento.status, is_duplicate: duplicata !== null, duplicata, cached_response: evento.response_body }],
      error: null,
    };
  },
};

const mockRpc = vi.fn().mockImplementation((fnName: string, args: Record<string, unknown>) => {
  if (inboxFiel.ligada && fnName === 'aceitar_entrega_inbox_chatwoot') return Promise.resolve(inboxFiel.aceitar(args));
  if (fnName === 'aceitar_entrega_inbox_chatwoot') {
    const duplicata = mockInboxRegisterResult.is_duplicate ? 'evento' : null;
    return Promise.resolve({ data: [{ ...mockInboxRegisterResult, duplicata }], error: null });
  }
  if (fnName === 'registrar_tentativa_limite_taxa') {
    if (limitePermite === null) return Promise.resolve({ data: null, error: { message: 'connection refused' } });
    return Promise.resolve({ data: [{ permitido: limitePermite, contagem: 1, reset_em: new Date(Date.now() + 60_000).toISOString() }], error: null });
  }
  return Promise.resolve({ data: null, error: null });
});

vi.mock('@/lib/supabaseServer', () => ({
  supabaseServer: {
    rpc: (...args: unknown[]) => mockRpc(...(args as [string, Record<string, unknown>])),
    from: (table: string) => {
      if (table === 'conexoes_integracao') {
        return {
          select: () => ({
            eq: (col: string, val: string) => ({
              eq: () => ({
                maybeSingle: () => {
                  const conn = connections[val];
                  return Promise.resolve({ data: conn ? { id: val, ...conn } : null, error: null });
                },
              }),
            }),
          }),
        };
      }
      if (table === 'credenciais_integracao') {
        return {
          select: () => ({
            eq: () => ({
              eq: (_col2: string, conexaoId: string) => ({
                maybeSingle: () => {
                  const cipher = credentials[conexaoId];
                  return Promise.resolve({
                    data: cipher ? { dados_cifrados: cipher, chave_versao: 'v1' } : null,
                    error: null,
                  });
                },
              }),
            }),
          }),
        };
      }
      if (table === 'membros_organizacao') {
        return {
          select: () => ({
            eq: (_col: string, orgId: string) => ({
              eq: () => ({
                limit: () => ({
                  maybeSingle: () => {
                    const owner = orgId === ORG_A ? OWNER_A : orgId === ORG_B ? OWNER_B : null;
                    return Promise.resolve({ data: owner ? { user_id: owner } : null, error: null });
                  },
                }),
                maybeSingle: () => Promise.resolve({ data: { papel: 'owner' }, error: null }),
              }),
            }),
          }),
        };
      }
      if (table === 'chatwoot_inboxes') {
        return {
          select: () => ({
            eq: (_c: string, conexaoId: string) => ({
              eq: (_c2: string, inboxId: number) => ({
                maybeSingle: () => {
                  const found = inboxLookups.find((r) => r.conexao_id === conexaoId && r.inbox_id === inboxId);
                  return Promise.resolve({ data: found ? { id: 'row', organizacao_id: found.organizacao_id } : null, error: null });
                },
              }),
            }),
          }),
          insert: (row: Record<string, unknown>) => {
            insertedInboxRows.push(row);
            inboxLookups.push({
              conexao_id: row.conexao_id as string,
              inbox_id: row.inbox_id as number,
              organizacao_id: row.organizacao_id as string,
            });
            return Promise.resolve({ error: null });
          },
        };
      }
      if (table === 'inbox_eventos_chatwoot') {
        return {
          select: () => ({
            eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { id: 'evt-1' }, error: null }) }) }),
          }),
        };
      }
      return { upsert: mockUpsert, update: mockUpdate };
    },
  },
}));

function signBody(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)): { signature: string; timestamp: string } {
  const hex = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return { signature: `sha256=${hex}`, timestamp: String(timestamp) };
}

describe('Chatwoot per-connection webhook: security and idempotent inbox', () => {
  beforeAll(() => {
    connections = {
      [CONEXAO_A]: { organizacao_id: ORG_A, status: 'conectado' },
      [CONEXAO_B]: { organizacao_id: ORG_B, status: 'conectado' },
      [CONEXAO_SEM_DONO]: { organizacao_id: ORG_SEM_DONO, status: 'conectado' },
    };
    credentials = {
      [CONEXAO_A]: encrypt(
        JSON.stringify({ api_url: 'https://a.chatwoot.test', api_token: 'tok-a', account_id: '1', webhook_secret: SECRET_A }),
      ) as string,
      [CONEXAO_B]: encrypt(
        JSON.stringify({ api_url: 'https://b.chatwoot.test', api_token: 'tok-b', account_id: '1', webhook_secret: SECRET_B }),
      ) as string,
      [CONEXAO_SEM_DONO]: encrypt(
        JSON.stringify({ api_url: 'https://c.chatwoot.test', api_token: 'tok-c', account_id: '1', webhook_secret: SECRET_SEM_DONO }),
      ) as string,
    };
  });

  async function postWebhook(
    conexaoId: string,
    body: string,
    headers?: { signature?: string; timestamp?: string },
  ) {
    const { POST } = await import('./route');
    const reqHeaders: Record<string, string> = {};
    if (headers?.signature) reqHeaders['x-chatwoot-signature'] = headers.signature;
    if (headers?.timestamp) reqHeaders['x-chatwoot-timestamp'] = headers.timestamp;
    const req = new Request(`https://orbita.test/api/chatwoot/webhook/${conexaoId}`, {
      method: 'POST',
      headers: reqHeaders,
      body,
    });
    return POST(req, { params: Promise.resolve({ conexaoId }) });
  }

  it('rejects an unknown connection id', async () => {
    const body = JSON.stringify({ event: 'message_created', account: { id: 1 } });
    const { signature, timestamp } = signBody('irrelevant-secret', body);
    const res = await postWebhook('99999999-9999-4999-8999-999999999999', body, { signature, timestamp });
    expect(res.status).toBe(404);
  });

  it.each(['conversation_created', 'conversation_updated'])('aceita %s assinado apenas como evidência da inbox', async (event) => {
    mockInboxRegisterResult = { evento_id: 'evt-a1', status: 'received', is_duplicate: false, cached_response: null };
    mockRpc.mockClear();
    const body = JSON.stringify({ event, account: { id: 1 }, id: 17, inbox_id: 7, status: 'open',
      created_at: 1793605011, meta: { assignee: event === 'conversation_created' ? null : { id: 13 } } });
    const signed = signBody(SECRET_A, body);
    expect((await postWebhook(CONEXAO_A, body.replace('"open"', '"pending"'), signed)).status).toBe(401);
    expect((await postWebhook(CONEXAO_A, body, signed)).status).toBe(200);
    expect(mockRpc.mock.calls.map(([fn]) => fn)).not.toContain('iniciar_ai_first_chatwoot');
    expect(mockRpc).toHaveBeenCalledWith('aceitar_entrega_inbox_chatwoot', expect.objectContaining({
      p_event_type: event,
      p_organizacao_id: ORG_A,
      p_conexao_id: CONEXAO_A,
      p_inbox_id: 7,
      p_payload: expect.objectContaining({
        conversation: expect.objectContaining({ id: 17, assignee_id: event === 'conversation_created' ? null : 13 }),
      }),
    }));
  });

  it('rejects a request without a signature header (fail-closed)', async () => {
    const body = JSON.stringify({ event: 'message_created', account: { id: 1 } });
    const res = await postWebhook(CONEXAO_A, body);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ success: false, error: 'Assinatura ausente' });
  });

  it('rejects an invalid/tampered signature', async () => {
    const body = JSON.stringify({ event: 'message_created', account: { id: 1 } });
    const res = await postWebhook(CONEXAO_A, body, {
      signature: 'sha256=not-a-real-signature-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      timestamp: String(Math.floor(Date.now() / 1000)),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ success: false, error: 'Assinatura inválida' });
  });

  it('rejects a payload that does not match the Chatwoot webhook schema', async () => {
    const body = JSON.stringify({ notEvent: true });
    const { signature, timestamp } = signBody(SECRET_A, body);
    const res = await postWebhook(CONEXAO_A, body, { signature, timestamp });
    expect(res.status).toBe(400);
  });

  it('rejects when the payload account_id does not match the connection', async () => {
    const body = JSON.stringify({
      event: 'message_created',
      account: { id: 999 },
      id: 1,
      inbox: { id: 10 },
      conversation: { id: 20 },
    });
    const { signature, timestamp } = signBody(SECRET_A, body);
    const res = await postWebhook(CONEXAO_A, body, { signature, timestamp });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ success: false, error: 'Conta Chatwoot não corresponde à conexão' });
  });

  it('rejects a side-effecting event with no resolvable inbox_id', async () => {
    const body = JSON.stringify({ event: 'message_created', account: { id: 1 }, id: 1, conversation: {} });
    const { signature, timestamp } = signBody(SECRET_A, body);
    const res = await postWebhook(CONEXAO_A, body, { signature, timestamp });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ success: false, error: 'Inbox não identificada' });
  });

  it('PRE-008: conexão desligada recusa a entrega assinada, sem mapping, inbox nem efeito', async () => {
    connections[CONEXAO_A]!.status = 'desconectado';
    mockUpsert.mockClear();
    mockRpc.mockClear();
    const inboxesAntes = insertedInboxRows.length;
    try {
      const body = JSON.stringify({
        event: 'message_created',
        account: { id: 1 },
        id: 502,
        content: 'mensagem depois de desligar',
        inbox: { id: 7 },
        conversation: { id: 207, inbox_id: 7, contact: { id: 107 } },
        sender: { id: 107, type: 'contact' },
      });
      const { signature, timestamp } = signBody(SECRET_A, body);
      const res = await postWebhook(CONEXAO_A, body, { signature, timestamp });

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ success: false, error: 'Conexão Chatwoot desligada' });
      expect(insertedInboxRows).toHaveLength(inboxesAntes);
      expect(mockRpc).not.toHaveBeenCalled();
    } finally {
      connections[CONEXAO_A]!.status = 'conectado';
    }
  });

  it('PRE-008: owner removido — a entrega assinada é recusada sem mapping, inbox nem efeito', async () => {
    mockUpsert.mockClear();
    mockRpc.mockClear();
    const inboxesAntes = insertedInboxRows.length;
    const erro = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const body = JSON.stringify({
        event: 'message_created',
        account: { id: 1 },
        id: 503,
        inbox: { id: 9 },
        conversation: { id: 209, inbox_id: 9, contact: { id: 109 } },
        sender: { id: 109, type: 'contact' },
      });
      const { signature, timestamp } = signBody(SECRET_SEM_DONO, body);
      const res = await postWebhook(CONEXAO_SEM_DONO, body, { signature, timestamp });

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ success: false, error: 'Escopo organizacional inválido' });
      expect(insertedInboxRows).toHaveLength(inboxesAntes);
      // Só o contador de limite (depois da assinatura); nenhuma escrita na inbox.
      expect(mockRpc.mock.calls.map(([fn]) => fn)).toEqual(['registrar_tentativa_limite_taxa']);
    } finally {
      erro.mockRestore();
    }
  });

  it('PRE-008: conexão desligada com assinatura inválida responde 401, sem revelar o estado', async () => {
    connections[CONEXAO_A]!.status = 'desconectado';
    try {
      const body = JSON.stringify({ event: 'message_created', account: { id: 1 } });
      const { signature, timestamp } = signBody('segredo-errado', body);
      const res = await postWebhook(CONEXAO_A, body, { signature, timestamp });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ success: false, error: 'Assinatura inválida' });
    } finally {
      connections[CONEXAO_A]!.status = 'conectado';
    }
  });

  it('aceita a entrega assinada na inbox com a organização da conexão e não consome na requisição', async () => {
    mockInboxRegisterResult = { evento_id: 'evt-a1', status: 'received', is_duplicate: false, cached_response: null };
    mockUpsert.mockClear();
    mockRpc.mockClear();

    const body = JSON.stringify({
      event: 'message_created',
      account: { id: 1 },
      id: 501,
      content: 'Olá atendente',
      message_type: 'incoming',
      inbox: { id: 1 },
      conversation: {
        id: 201,
        display_id: 1,
        inbox_id: 1,
        status: 'open',
        contact: { id: 101, name: 'Cliente A', phone_number: '+5511999990001' },
      },
      sender: { id: 101, name: 'Cliente A', type: 'contact' },
    });

    const { signature: sigA, timestamp: tsA } = signBody(SECRET_A, body);
    const res = await postWebhook(CONEXAO_A, body, { signature: sigA, timestamp: tsA });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(mockRpc).toHaveBeenCalledWith('aceitar_entrega_inbox_chatwoot', expect.objectContaining({
      p_organizacao_id: ORG_A,
      p_conexao_id: CONEXAO_A,
      p_user_id: OWNER_A,
      p_inbox_id: 1,
      p_idempotency_key: 'v2:message_created:msg:501',
    }));
    // Mapping, espelho, caso e conclusão são do worker (MSG-006).
    const rpcs = mockRpc.mock.calls.map(([nome]) => nome);
    expect(rpcs).not.toContain('concluir_evento_inbox_chatwoot');
    expect(rpcs).not.toContain('aplicar_evento_inbox_chatwoot');
    expect(insertedInboxRows).toHaveLength(0);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('as mesmas chaves remotas em A e B entram cada uma na sua organização e conexão', async () => {
    mockRpc.mockClear();
    mockInboxRegisterResult = { evento_id: 'evt-b1', status: 'received', is_duplicate: false, cached_response: null };
    const bodyDe = (conteudo: string) => JSON.stringify({
      event: 'message_created',
      account: { id: 1 },
      id: 777,
      content: conteudo,
      inbox: { id: 1 },
      conversation: { id: 999, inbox_id: 1, contact: { id: 555, name: 'Cliente' } },
    });
    for (const [conexao, segredo] of [[CONEXAO_A, SECRET_A], [CONEXAO_B, SECRET_B]] as const) {
      const body = bodyDe(conexao);
      const { signature, timestamp } = signBody(segredo, body);
      expect((await postWebhook(conexao, body, { signature, timestamp })).status).toBe(200);
    }
    const aceites = mockRpc.mock.calls.filter(([nome]) => nome === 'aceitar_entrega_inbox_chatwoot').map(([, a]) => a);
    expect(aceites).toEqual([
      expect.objectContaining({ p_organizacao_id: ORG_A, p_conexao_id: CONEXAO_A }),
      expect.objectContaining({ p_organizacao_id: ORG_B, p_conexao_id: CONEXAO_B }),
    ]);
  });

  it('duplicata já processada responde 200 sem repetir nada e sem devolver a resposta interna', async () => {
    mockRpc.mockClear();
    mockInboxRegisterResult = {
      evento_id: 'evt-a1',
      status: 'processed',
      is_duplicate: true,
      cached_response: { success: true, casoId: 'interno' },
    };
    const body = JSON.stringify({
      event: 'message_created',
      account: { id: 1 },
      id: 501,
      inbox: { id: 1 },
      conversation: { id: 201, inbox_id: 1 },
    });

    const { signature, timestamp } = signBody(SECRET_A, body);
    const res = await postWebhook(CONEXAO_A, body, { signature, timestamp });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(mockRpc.mock.calls.map(([nome]) => nome)).not.toContain('concluir_evento_inbox_chatwoot');
  });
});

describe('MSG-005: aceite na inbox com dedup de entrega e revisão antes do ACK', () => {
  const CONVERSA = { id: 960, inbox_id: 1, status: 'open', contact: { id: 961, name: 'Cliente 961' } };

  function corpo(extra: Record<string, unknown>): string {
    return JSON.stringify({ event: 'message_created', account: { id: 1 }, inbox: { id: 1 }, conversation: CONVERSA, ...extra });
  }

  async function entregar(
    body: string | Buffer,
    opcoes: { delivery?: string; segredo?: string; conexao?: string; timestamp?: number; corpoAssinado?: string | Buffer } = {},
  ) {
    const { POST } = await import('./route');
    const timestamp = String(opcoes.timestamp ?? Math.floor(Date.now() / 1000));
    const assinado = opcoes.corpoAssinado ?? body;
    const hex = crypto.createHmac('sha256', opcoes.segredo ?? SECRET_A).update(`${timestamp}.`).update(assinado).digest('hex');
    const headers: Record<string, string> = { 'x-chatwoot-signature': `sha256=${hex}`, 'x-chatwoot-timestamp': timestamp };
    if (opcoes.delivery) headers['x-chatwoot-delivery'] = opcoes.delivery;
    const conexaoId = opcoes.conexao ?? CONEXAO_A;
    const req = new Request(`https://orbita.test/api/chatwoot/webhook/${conexaoId}`, { method: 'POST', headers, body: typeof body === 'string' ? body : new Uint8Array(body) });
    return POST(req, { params: Promise.resolve({ conexaoId }) });
  }

  const chamadas = (fn: string) => mockRpc.mock.calls.filter(([nome]) => nome === fn).map(([, args]) => args as Record<string, unknown>);

  beforeEach(() => {
    inboxFiel.ligada = true;
    inboxFiel.falha = null;
    inboxFiel.eventos.clear();
    inboxFiel.entregas.clear();
    limitePermite = true;
    mockRpc.mockClear();
  });
  afterEach(() => {
    inboxFiel.ligada = false;
    limitePermite = true;
  });

  it('o mesmo delivery id várias vezes: um evento, 200 em todas e nenhum consumo na requisição', async () => {
    const body = corpo({ id: 9601, content: 'primeira' });
    const respostas = [];
    for (let i = 0; i < 3; i += 1) respostas.push(await entregar(body, { delivery: 'del-9601' }));
    expect(respostas.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(inboxFiel.eventos.size).toBe(1);
    expect(mockRpc.mock.calls.map(([nome]) => nome)).not.toContain('aplicar_evento_inbox_chatwoot');
  });

  it('entrega sem delivery id: aceita; o message_created repetido é deduplicado pela identidade lógica', async () => {
    const body = corpo({ id: 9603, content: 'sem id de entrega' });
    expect((await entregar(body)).status).toBe(200);
    expect((await entregar(body, { timestamp: Math.floor(Date.now() / 1000) + 5 })).status).toBe(200);
    expect(chamadas('aceitar_entrega_inbox_chatwoot').map((a) => a.p_delivery_id)).toEqual([null, null]);
    expect(inboxFiel.eventos.size).toBe(1);
  });

  it('message_created duplicado em entregas diferentes: um evento', async () => {
    const body = corpo({ id: 9604, content: 'criada' });
    await entregar(body, { delivery: 'del-9604-a' });
    await entregar(body, { delivery: 'del-9604-b' });
    expect(inboxFiel.eventos.size).toBe(1);
  });

  it('message_updated com três revisões: todas entram na inbox, inclusive a volta ao conteúdo anterior', async () => {
    await entregar(corpo({ id: 9605, content: 'v0' }), { delivery: 'del-9605-c' });
    await entregar(corpo({ event: 'message_updated', id: 9605, content: 'v1' }), { delivery: 'del-9605-u1' });
    await entregar(corpo({ event: 'message_updated', id: 9605, content: 'v2' }), { delivery: 'del-9605-u2' });
    await entregar(corpo({ event: 'message_updated', id: 9605, content: 'v1' }), { delivery: 'del-9605-u3' });
    expect(inboxFiel.eventos.size).toBe(4);
  });

  it('status repetido separado por outras transições: open → resolved → open → resolved, quatro ocorrências', async () => {
    const sequencia = ['open', 'resolved', 'open', 'resolved'];
    for (const [i, status] of sequencia.entries()) {
      const body = JSON.stringify({
        event: 'conversation_status_changed', account: { id: 1 }, inbox: { id: 1 }, conversation: { ...CONVERSA, status },
      });
      expect((await entregar(body, { delivery: `del-9606-s${i}` })).status).toBe(200);
    }
    expect([...inboxFiel.eventos.values()].filter((e) => e.chave.startsWith('v2:conversation_status_changed'))).toHaveLength(4);
  });

  it('fora de ordem: a segunda edição chega antes da primeira e as duas ficam na inbox', async () => {
    await entregar(corpo({ id: 9607, content: 'base' }), { delivery: 'del-9607-c' });
    expect((await entregar(corpo({ event: 'message_updated', id: 9607, content: 'r2', updated_at: '2026-10-27T10:00:02Z' }),
      { delivery: 'del-9607-r2' })).status).toBe(200);
    expect((await entregar(corpo({ event: 'message_updated', id: 9607, content: 'r1', updated_at: '2026-10-27T10:00:01Z' }),
      { delivery: 'del-9607-r1' })).status).toBe(200);
    expect([...inboxFiel.eventos.values()].filter((e) => e.chave.includes(':msg:9607:'))).toHaveLength(2);
  });

  it('delivery id reaproveitado com outro evento: 409 e nada gravado', async () => {
    await entregar(corpo({ id: 9609, content: 'um' }), { delivery: 'del-9609' });
    const res = await entregar(corpo({ id: 9610, content: 'outro' }), { delivery: 'del-9609' });
    expect(res.status).toBe(409);
    expect(inboxFiel.eventos.size).toBe(1);
  });

  it('falha do banco antes do commit: não-2xx sem texto interno; a reentrega depois grava', async () => {
    inboxFiel.falha = { code: '08006', message: 'connection failure host=db.interno' };
    const body = corpo({ id: 9611, content: 'banco fora', inbox: { id: 61 }, conversation: { ...CONVERSA, id: 9611, inbox_id: 61 } });
    const res = await entregar(body, { delivery: 'del-9611' });
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).not.toContain('db.interno');
    expect(inboxFiel.eventos.size).toBe(0);

    inboxFiel.falha = null;
    expect((await entregar(body, { delivery: 'del-9611' })).status).toBe(200);
    expect(inboxFiel.eventos.size).toBe(1);
  });

  it('corpo adulterado depois de assinado: 401 sem tocar a inbox', async () => {
    const assinado = corpo({ id: 9612, content: 'original' });
    const res = await entregar(assinado.replace('original', 'adulterado'), { delivery: 'del-9612', corpoAssinado: assinado });
    expect(res.status).toBe(401);
    expect(chamadas('aceitar_entrega_inbox_chatwoot')).toHaveLength(0);
  });

  it('HMAC sobre os bytes originais: acento assinado em bytes é aceito; UTF-8 inválido é 400 depois da assinatura', async () => {
    const bytes = Buffer.from(corpo({ id: 9613, content: 'ação' }), 'utf8');
    expect((await entregar(bytes, { delivery: 'del-9613' })).status).toBe(200);
    const invalido = Buffer.concat([Buffer.from('{"event":"message_created","content":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}')]);
    const res = await entregar(invalido, { delivery: 'del-9614' });
    expect(res.status).toBe(400);
    expect(chamadas('aceitar_entrega_inbox_chatwoot')).toHaveLength(1);
  });

  it('payload acima do limite: 413 antes de qualquer consulta, também sem Content-Length', async () => {
    const grande = corpo({ id: 9615, content: 'x'.repeat(300 * 1024) });
    expect((await entregar(grande, { delivery: 'del-9615' })).status).toBe(413);
    const { POST } = await import('./route');
    const fluxo = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 40; i += 1) controller.enqueue(new Uint8Array(10 * 1024));
        controller.close();
      },
    });
    const semTamanho = new Request(`https://orbita.test/api/chatwoot/webhook/${CONEXAO_A}`, {
      method: 'POST', body: fluxo, duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    expect((await POST(semTamanho, { params: Promise.resolve({ conexaoId: CONEXAO_A }) })).status).toBe(413);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('cabeçalho de entrega ou assinatura fora do formato: recusado antes de consultar a conexão', async () => {
    const body = corpo({ id: 9616 });
    expect((await entregar(body, { delivery: 'id com espaço' })).status).toBe(400);
    const { POST } = await import('./route');
    const req = new Request(`https://orbita.test/api/chatwoot/webhook/${CONEXAO_A}`, {
      method: 'POST', headers: { 'x-chatwoot-signature': 'md5=abc', 'x-chatwoot-timestamp': 'agora' }, body,
    });
    expect((await POST(req, { params: Promise.resolve({ conexaoId: CONEXAO_A }) })).status).toBe(401);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('limite excedido: 429 sem gravar; contador indisponível: 503 (fail-closed)', async () => {
    limitePermite = false;
    expect((await entregar(corpo({ id: 9617 }), { delivery: 'del-9617' })).status).toBe(429);
    limitePermite = null;
    expect((await entregar(corpo({ id: 9617 }), { delivery: 'del-9617' })).status).toBe(503);
    expect(chamadas('aceitar_entrega_inbox_chatwoot')).toHaveLength(0);
  });

  it('account de outra conexão/organização: 403 sem gravar; o segredo de B não autentica a URL de A', async () => {
    expect((await entregar(corpo({ id: 9618, account: { id: 999 } }), { delivery: 'del-9618' })).status).toBe(403);
    expect((await entregar(corpo({ id: 9619 }), { delivery: 'del-9619', segredo: SECRET_B })).status).toBe(401);
    expect(chamadas('aceitar_entrega_inbox_chatwoot')).toHaveLength(0);
  });

  it('logs da entrega não carregam conteúdo da mensagem, nome do contato nem a assinatura', async () => {
    const saidas: string[] = [];
    const capturar = (...args: unknown[]) => { saidas.push(args.map(String).join(' ')); };
    const espioes = [
      vi.spyOn(console, 'info').mockImplementation(capturar),
      vi.spyOn(console, 'warn').mockImplementation(capturar),
      vi.spyOn(console, 'error').mockImplementation(capturar),
    ];
    try {
      inboxFiel.falha = { code: '08006', message: 'falha' };
      await entregar(corpo({ id: 9620, content: 'CONTEUDO-PRIVADO-9620' }), { delivery: 'del-9620' });
      inboxFiel.falha = null;
      await entregar(corpo({ id: 9620, content: 'CONTEUDO-PRIVADO-9620' }), { delivery: 'del-9620' });
    } finally {
      espioes.forEach((s) => s.mockRestore());
    }
    const log = saidas.join('\n');
    expect(log).toContain('chatwoot.webhook.recusada');
    expect(log).toContain('chatwoot.webhook.aceita');
    expect(log).not.toContain('CONTEUDO-PRIVADO-9620');
    expect(log).not.toContain('Cliente 961');
    expect(log).not.toContain('sha256=');
  });
});
