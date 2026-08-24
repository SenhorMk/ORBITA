import { beforeAll, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';

const mockUpsert = vi.fn().mockResolvedValue({ error: null });
const mockUpdate = vi.fn().mockReturnValue({
  eq: vi.fn().mockReturnValue({
    eq: vi.fn().mockResolvedValue({ error: null }),
  }),
});

let mockInboxLookup: { user_id: string; organizacao_id?: string; conexao_id?: string } | null = null;

let mockInboxResult = {
  evento_id: 'chatwoot-inbox-evt-1',
  status: 'received',
  is_duplicate: false,
  cached_response: null as Record<string, unknown> | null,
};

const mockRpc = vi.fn().mockImplementation((fnName: string) => {
  if (fnName === 'registrar_evento_inbox_chatwoot') {
    return Promise.resolve({ data: [mockInboxResult], error: null });
  }
  if (fnName === 'concluir_evento_inbox_chatwoot') {
    return Promise.resolve({ data: null, error: null });
  }
  return Promise.resolve({ data: null, error: null });
});

vi.mock('../../../../lib/supabaseServer', () => ({
  supabaseServer: {
    rpc: (...args: unknown[]) => mockRpc(...(args as [string, Record<string, unknown>])),
    from: (table: string) => {
      if (table === 'chatwoot_inboxes') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: mockInboxLookup, error: null }),
            }),
          }),
        };
      }
      if (table === 'membros_organizacao') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: () => Promise.resolve({ data: { papel: 'owner' }, error: null }),
              }),
              order: () => ({
                limit: () => ({
                  maybeSingle: () =>
                    Promise.resolve({
                      data: { organizacao_id: '22222222-2222-4222-8222-222222222222' },
                      error: null,
                    }),
                }),
              }),
            }),
          }),
        };
      }
      if (table === 'inbox_eventos_chatwoot') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: () => Promise.resolve({ data: { id: 'chatwoot-inbox-evt-1' }, error: null }),
              }),
            }),
          }),
        };
      }
      return {
        upsert: mockUpsert,
        update: mockUpdate,
      };
    },
  },
}));

describe('Chatwoot Webhook Endpoint Security & Idempotent Inbox', () => {
  const secret = 'chatwoot_test_secret_key_1234567890';

  beforeAll(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project-ref.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'public-key-12345678901234567890';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'server-key-12345678901234567890';
    process.env.CHATWOOT_WEBHOOK_SECRET = secret;
  });

  it('provides a clean GET health check endpoint', async () => {
    const { GET: getHandler } = await import('./route');
    const response = await getHandler();
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.status).toBe('ok');
    expect(json.message).toContain('Webhook do Chatwoot');
  });

  it('rejects webhook requests when CHATWOOT_WEBHOOK_SECRET is unconfigured or placeholder', async () => {
    const originalSecret = process.env.CHATWOOT_WEBHOOK_SECRET;
    process.env.CHATWOOT_WEBHOOK_SECRET = 'sua_assinatura_webhook_chatwoot_aqui';
    const { POST: webhookHandler } = await import('./route');

    const req = new Request('https://orbita.test/api/chatwoot/webhook', {
      method: 'POST',
      body: JSON.stringify({ event: 'message_created' }),
    });

    const response = await webhookHandler(req);
    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json).toEqual({ success: false, error: 'Configuração inválida no servidor' });

    process.env.CHATWOOT_WEBHOOK_SECRET = originalSecret;
  });

  it('rejects webhook requests without signature header (fail-closed)', async () => {
    const { POST: webhookHandler } = await import('./route');
    const req = new Request('https://orbita.test/api/chatwoot/webhook', {
      method: 'POST',
      body: JSON.stringify({ event: 'message_created' }),
    });

    const response = await webhookHandler(req);
    expect(response.status).toBe(401);
    const json = await response.json();
    expect(json).toEqual({ success: false, error: 'Assinatura ausente' });
  });

  it('rejects webhook requests with invalid or tampered signature', async () => {
    const { POST: webhookHandler } = await import('./route');
    const body = JSON.stringify({ event: 'message_created' });
    const req = new Request('https://orbita.test/api/chatwoot/webhook', {
      method: 'POST',
      headers: {
        'x-chatwoot-signature': 'invalid_signature_hex',
      },
      body,
    });

    const response = await webhookHandler(req);
    expect(response.status).toBe(401);
    const json = await response.json();
    expect(json).toEqual({ success: false, error: 'Assinatura inválida' });
  });

  it('rejects webhook requests when inbox cannot be resolved from server-side mapping', async () => {
    mockInboxLookup = null;
    const { POST: webhookHandler } = await import('./route');
    const body = JSON.stringify({
      event: 'message_created',
      inbox: { id: 999 },
    });
    const signature = crypto.createHmac('sha256', secret).update(body).digest('hex');

    const req = new Request('https://orbita.test/api/chatwoot/webhook?userId=attacker-uuid-1234', {
      method: 'POST',
      headers: {
        'x-chatwoot-signature': signature,
      },
      body,
    });

    const response = await webhookHandler(req);
    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json).toEqual({ success: false, error: 'Tenant não identificado' });
  });

  it('processes webhook and registers in inbox when signature is valid and inbox is registered', async () => {
    const verifiedTenantId = '70000000-0000-4000-8000-000000000001';
    mockInboxLookup = {
      user_id: verifiedTenantId,
      organizacao_id: '22222222-2222-4222-8222-222222222222',
    };
    mockInboxResult = {
      evento_id: 'chatwoot-inbox-evt-1',
      status: 'received',
      is_duplicate: false,
      cached_response: null,
    };
    mockUpsert.mockClear();
    mockRpc.mockClear();

    const { POST: webhookHandler } = await import('./route');
    const body = JSON.stringify({
      event: 'message_created',
      id: 501,
      content: 'Olá atendente',
      message_type: 'incoming',
      inbox: { id: 10 },
      conversation: {
        id: 201,
        display_id: 1,
        inbox_id: 10,
        status: 'open',
        contact: {
          id: 101,
          name: 'Cliente Teste',
          phone_number: '+5511999990001',
        },
      },
      sender: {
        id: 101,
        name: 'Cliente Teste',
        type: 'contact',
      },
    });

    const signature = crypto.createHmac('sha256', secret).update(body).digest('hex');

    const req = new Request('https://orbita.test/api/chatwoot/webhook', {
      method: 'POST',
      headers: {
        'x-chatwoot-signature': signature,
      },
      body,
    });

    const response = await webhookHandler(req);
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toEqual({ success: true });

    // Verify inbox registration
    expect(mockRpc).toHaveBeenCalledWith('registrar_evento_inbox_chatwoot', expect.objectContaining({
      p_idempotency_key: 'event_message_created_msg_501_conv_201',
      p_event_type: 'message_created',
      p_organizacao_id: '22222222-2222-4222-8222-222222222222',
    }));

    expect(mockRpc).toHaveBeenCalledWith('concluir_evento_inbox_chatwoot', expect.objectContaining({
      p_evento_id: 'chatwoot-inbox-evt-1',
      p_status: 'processed',
    }));

    // Verify contact upsert included organization_id
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 101,
        user_id: verifiedTenantId,
        organizacao_id: '22222222-2222-4222-8222-222222222222',
        name: 'Cliente Teste',
      }),
    );
  });

  it('handles duplicate webhook delivery safely by returning cached response without repeating side effects', async () => {
    const verifiedTenantId = '70000000-0000-4000-8000-000000000001';
    mockInboxLookup = {
      user_id: verifiedTenantId,
      organizacao_id: '22222222-2222-4222-8222-222222222222',
    };
    mockInboxResult = {
      evento_id: 'chatwoot-inbox-evt-1',
      status: 'processed',
      is_duplicate: true,
      cached_response: { success: true, cached: true },
    };
    mockUpsert.mockClear();

    const { POST: webhookHandler } = await import('./route');
    const body = JSON.stringify({
      event: 'message_created',
      id: 501,
      content: 'Olá atendente',
      inbox: { id: 10 },
      conversation: { id: 201 },
    });

    const signature = crypto.createHmac('sha256', secret).update(body).digest('hex');

    const req = new Request('https://orbita.test/api/chatwoot/webhook', {
      method: 'POST',
      headers: {
        'x-chatwoot-signature': signature,
      },
      body,
    });

    const response = await webhookHandler(req);
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toEqual({ success: true, cached: true });

    // No side effects should have occurred
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('updates conversation status when conversation_status_changed event is received', async () => {
    const verifiedTenantId = '70000000-0000-4000-8000-000000000001';
    mockInboxLookup = {
      user_id: verifiedTenantId,
      organizacao_id: '22222222-2222-4222-8222-222222222222',
    };
    mockInboxResult = {
      evento_id: 'chatwoot-inbox-evt-2',
      status: 'received',
      is_duplicate: false,
      cached_response: null,
    };
    mockUpdate.mockClear();

    const { POST: webhookHandler } = await import('./route');
    const body = JSON.stringify({
      event: 'conversation_status_changed',
      inbox: { id: 10 },
      conversation: {
        id: 201,
        status: 'resolved',
      },
    });

    const signature = crypto.createHmac('sha256', secret).update(body).digest('hex');

    const req = new Request('https://orbita.test/api/chatwoot/webhook', {
      method: 'POST',
      headers: {
        'x-chatwoot-signature': signature,
      },
      body,
    });

    const response = await webhookHandler(req);
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toEqual({ success: true });
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'resolved' }),
    );
  });
});
