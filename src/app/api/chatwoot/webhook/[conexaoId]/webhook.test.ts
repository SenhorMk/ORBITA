import { beforeAll, describe, expect, it, vi } from 'vitest';
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

const mockRpc = vi.fn().mockImplementation((fnName: string) => {
  if (fnName === 'registrar_evento_inbox_chatwoot') {
    return Promise.resolve({ data: [mockInboxRegisterResult], error: null });
  }
  if (fnName === 'concluir_evento_inbox_chatwoot') {
    return Promise.resolve({ data: null, error: null });
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
      expect(mockUpsert).not.toHaveBeenCalled();
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
      expect(mockRpc).not.toHaveBeenCalled();
      expect(mockUpsert).not.toHaveBeenCalled();
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

  it('processes a valid signed event, auto-registers the inbox mapping and marks it processed', async () => {
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
    expect(insertedInboxRows).toContainEqual(
      expect.objectContaining({ organizacao_id: ORG_A, conexao_id: CONEXAO_A, inbox_id: 1, account_id: '1' }),
    );
    expect(mockUpsert).toHaveBeenCalledWith(expect.objectContaining({ organizacao_id: ORG_A, id: 101 }));
    expect(mockRpc).toHaveBeenCalledWith(
      'concluir_evento_inbox_chatwoot',
      expect.objectContaining({ p_evento_id: 'evt-a1', p_status: 'processed' }),
    );
  });

  it('keeps organization A and B fully isolated when both use inbox_id=1 (overlapping external ids)', async () => {
    mockUpsert.mockClear();

    mockInboxRegisterResult = { evento_id: 'evt-b1', status: 'received', is_duplicate: false, cached_response: null };
    const bodyB = JSON.stringify({
      event: 'message_created',
      account: { id: 1 },
      id: 777,
      content: 'Mensagem da organização B',
      message_type: 'incoming',
      inbox: { id: 1 },
      conversation: {
        id: 999,
        inbox_id: 1,
        status: 'open',
        contact: { id: 555, name: 'Cliente B', phone_number: '+5511888880000' },
      },
      sender: { id: 555, name: 'Cliente B', type: 'contact' },
    });

    const { signature: sigB, timestamp: tsB } = signBody(SECRET_B, bodyB);
    const res = await postWebhook(CONEXAO_B, bodyB, { signature: sigB, timestamp: tsB });
    expect(res.status).toBe(200);

    // Org A's earlier inbox_id=1 registration and Org B's inbox_id=1 registration
    // are both present, scoped to their own connection/organization, never merged.
    expect(inboxLookups.filter((r) => r.inbox_id === 1)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ conexao_id: CONEXAO_A, organizacao_id: ORG_A }),
        expect.objectContaining({ conexao_id: CONEXAO_B, organizacao_id: ORG_B }),
      ]),
    );
    expect(mockUpsert).toHaveBeenCalledWith(expect.objectContaining({ organizacao_id: ORG_B, id: 555 }));
    expect(mockUpsert).not.toHaveBeenCalledWith(expect.objectContaining({ organizacao_id: ORG_A, id: 555 }));
  });

  it('replays a duplicate delivery as a no-op, returning the cached response without new side effects', async () => {
    mockUpsert.mockClear();
    mockInboxRegisterResult = {
      evento_id: 'evt-a1',
      status: 'processed',
      is_duplicate: true,
      cached_response: { success: true, cached: true },
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
    expect(await res.json()).toEqual({ success: true, cached: true });
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});
