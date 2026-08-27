import { beforeAll, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import crypto from 'node:crypto';

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project-ref.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'public-key-12345678901234567890';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'server-key-12345678901234567890';
process.env.ENCRYPTION_KEY = 'ab'.repeat(32);

import { encrypt } from '../../../../lib/crypto';

const plainSecret = 'secret-bling-12345';

const validTenantId = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

let mockInboxResult = {
  evento_id: 'inbox-evt-1',
  status: 'received',
  is_duplicate: false,
  cached_response: null as Record<string, unknown> | null,
};

let mockLinkedConnection: { id: string; organizacao_id: string } | null = {
  id: 'conn-123',
  organizacao_id: '11111111-1111-4111-8111-111111111111',
};
let mockMemberships: Array<{ organizacao_id: string }> = [
  { organizacao_id: '11111111-1111-4111-8111-111111111111' },
];

const mockRpc = vi.fn().mockImplementation((fnName: string) => {
  if (fnName === 'registrar_evento_inbox_bling') {
    return Promise.resolve({ data: [mockInboxResult], error: null });
  }
  if (fnName === 'concluir_evento_inbox_bling') {
    return Promise.resolve({ data: null, error: null });
  }
  return Promise.resolve({ data: null, error: null });
});

const mockUpsert = vi.fn().mockResolvedValue({ error: null });

vi.mock('../../../../lib/supabaseServer', () => ({
  supabaseServer: {
    rpc: (...args: unknown[]) => mockRpc(...(args as [string, Record<string, unknown>])),
    from: (table: string) => {
      if (table === 'integracoes_bling') {
        const encryptedSecret = encrypt('secret-bling-12345');
        const listData = [{ user_id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d', client_secret: encryptedSecret }];
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({
                  data: {
                    user_id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
                    client_secret: encryptedSecret,
                  },
                  error: null,
                }),
            }),
            maybeSingle: () =>
              Promise.resolve({
                data: {
                  user_id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
                  client_secret: encryptedSecret,
                },
                error: null,
              }),
            then: (onFulfilled: (res: { data: typeof listData; error: null }) => void) =>
              Promise.resolve({ data: listData, error: null }).then(onFulfilled),
          }),
        };
      }
      if (table === 'conexoes_integracao') {
        return {
          select: () => ({
            eq: () => ({
              contains: () => ({
                limit: () => ({
                  maybeSingle: () =>
                    Promise.resolve({
                      data: mockLinkedConnection,
                      error: null,
                    }),
                }),
              }),
            }),
          }),
        };
      }
      if (table === 'membros_organizacao') {
        return {
          select: () => ({
            eq: (col: string) => {
              if (col === 'organizacao_id') {
                return {
                  eq: () => ({
                    maybeSingle: () => Promise.resolve({ data: { papel: 'owner' }, error: null }),
                  }),
                };
              }
              // .eq('user_id', tenant.id) — resolução de organização inequívoca do webhook
              return Promise.resolve({ data: mockMemberships, error: null });
            },
          }),
        };
      }
      if (table === 'inbox_eventos_bling') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: () => Promise.resolve({ data: { id: 'inbox-evt-1' }, error: null }),
              }),
            }),
          }),
        };
      }
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({ data: null, error: null }),
          }),
        }),
        upsert: mockUpsert,
      };
    },
  },
}));

vi.mock('../../../../repositories/produtoRepository', () => ({
  produtoRepository: {
    getByBlingId: vi.fn().mockResolvedValue(null),
    upsert: vi.fn().mockResolvedValue({ id: 'prod-123' }),
  },
}));

vi.mock('../../../../repositories/clienteRepository', () => ({
  clienteRepository: {
    getByBlingId: vi.fn().mockResolvedValue(null),
    upsert: vi.fn().mockResolvedValue({ id: 'cli-123' }),
  },
}));

vi.mock('../../../../repositories/pedidoRepository', () => ({
  pedidoRepository: {
    upsert: vi.fn().mockResolvedValue({ id: 'ped-123' }),
    addItems: vi.fn().mockResolvedValue(undefined),
  },
}));

describe('Bling Webhook Endpoint Security & Idempotent Inbox', () => {
  beforeAll(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project-ref.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'public-key-12345678901234567890';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'server-key-12345678901234567890';
    process.env.ENCRYPTION_KEY = 'ab'.repeat(32);
  });

  it('rejects webhook requests without signature header (fail-closed)', async () => {
    const { POST: webhookHandler } = await import('./route');
    const req = new NextRequest('https://orbita.test/api/bling/webhook', {
      method: 'POST',
      body: JSON.stringify({ event: 'order_updated', data: { id: 12345 } }),
    });

    const response = await webhookHandler(req);
    expect(response.status).toBe(403);
    const json = await response.json();
    expect(json).toEqual({ success: false, error: 'Assinatura ausente' });
  });

  it('rejects webhook requests with invalid or tampered signature', async () => {
    const { POST: webhookHandler } = await import('./route');
    const req = new NextRequest('https://orbita.test/api/bling/webhook', {
      method: 'POST',
      headers: {
        'x-bling-signature-256': 'sha256=invalid-or-tampered-signature-123456',
      },
      body: JSON.stringify({ event: 'order_updated', data: { id: 12345 } }),
    });

    const response = await webhookHandler(req);
    expect(response.status).toBe(403);
    const json = await response.json();
    expect(json).toEqual({ success: false, error: 'Assinatura inválida' });
  });

  it('processes valid signed webhook event, registers in inbox and marks as processed', async () => {
    mockInboxResult = {
      evento_id: 'inbox-evt-1',
      status: 'received',
      is_duplicate: false,
      cached_response: null,
    };

    const { POST: webhookHandler } = await import('./route');
    const rawPayload = JSON.stringify({
      event: 'stock.updated',
      data: {
        idProduto: 'PROD-88',
        nome: 'Tenis Esportivo',
        preco: 299.9,
        saldoFisico: 15,
      },
    });
    const signature = `sha256=${crypto.createHmac('sha256', plainSecret).update(rawPayload).digest('hex')}`;

    const req = new NextRequest(`https://orbita.test/api/bling/webhook?userId=${validTenantId}`, {
      method: 'POST',
      headers: {
        'x-bling-signature-256': signature,
        'content-type': 'application/json',
      },
      body: rawPayload,
    });

    const response = await webhookHandler(req);
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.processedProducts).toBe(1);

    expect(mockRpc).toHaveBeenCalledWith('registrar_evento_inbox_bling', expect.objectContaining({
      p_idempotency_key: 'stock.updated_PROD-88',
      p_event_type: 'stock.updated',
    }));
    expect(mockRpc).toHaveBeenCalledWith('concluir_evento_inbox_bling', expect.objectContaining({
      p_evento_id: 'inbox-evt-1',
      p_status: 'processed',
    }));
  });

  it('handles duplicate webhook delivery safely by returning cached response without repeating side effects', async () => {
    mockInboxResult = {
      evento_id: 'inbox-evt-1',
      status: 'processed',
      is_duplicate: true,
      cached_response: { success: true, processedProducts: 1 },
    };

    const { POST: webhookHandler } = await import('./route');
    const rawPayload = JSON.stringify({
      event: 'stock.updated',
      data: {
        idProduto: 'PROD-88',
        nome: 'Tenis Esportivo',
        preco: 299.9,
        saldoFisico: 15,
      },
    });
    const signature = `sha256=${crypto.createHmac('sha256', plainSecret).update(rawPayload).digest('hex')}`;

    const req = new NextRequest(`https://orbita.test/api/bling/webhook?userId=${validTenantId}`, {
      method: 'POST',
      headers: {
        'x-bling-signature-256': signature,
        'content-type': 'application/json',
      },
      body: rawPayload,
    });

    const response = await webhookHandler(req);
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.processedProducts).toBe(1);
  });

  it('fails closed when the legacy tenant has no linked connection and belongs to zero organizations (never guesses)', async () => {
    mockLinkedConnection = null;
    mockMemberships = [];

    const { POST: webhookHandler } = await import('./route');
    const rawPayload = JSON.stringify({
      event: 'stock.updated',
      data: { idProduto: 'PROD-99', nome: 'Produto orfao', preco: 10, saldoFisico: 1 },
    });
    const signature = `sha256=${crypto.createHmac('sha256', plainSecret).update(rawPayload).digest('hex')}`;

    const req = new NextRequest(`https://orbita.test/api/bling/webhook?userId=${validTenantId}`, {
      method: 'POST',
      headers: { 'x-bling-signature-256': signature, 'content-type': 'application/json' },
      body: rawPayload,
    });

    const response = await webhookHandler(req);
    expect(response.status).toBe(403);
    const json = await response.json();
    expect(json.success).toBe(false);

    mockLinkedConnection = { id: 'conn-123', organizacao_id: '11111111-1111-4111-8111-111111111111' };
    mockMemberships = [{ organizacao_id: '11111111-1111-4111-8111-111111111111' }];
  });

  it('fails closed when the legacy tenant belongs to more than one organization (never picks the first one)', async () => {
    mockLinkedConnection = null;
    mockMemberships = [
      { organizacao_id: '11111111-1111-4111-8111-111111111111' },
      { organizacao_id: '22222222-2222-4222-8222-222222222222' },
    ];

    const { POST: webhookHandler } = await import('./route');
    const rawPayload = JSON.stringify({
      event: 'stock.updated',
      data: { idProduto: 'PROD-99', nome: 'Produto ambiguo', preco: 10, saldoFisico: 1 },
    });
    const signature = `sha256=${crypto.createHmac('sha256', plainSecret).update(rawPayload).digest('hex')}`;

    const req = new NextRequest(`https://orbita.test/api/bling/webhook?userId=${validTenantId}`, {
      method: 'POST',
      headers: { 'x-bling-signature-256': signature, 'content-type': 'application/json' },
      body: rawPayload,
    });

    const response = await webhookHandler(req);
    expect(response.status).toBe(403);
    const json = await response.json();
    expect(json.success).toBe(false);

    mockLinkedConnection = { id: 'conn-123', organizacao_id: '11111111-1111-4111-8111-111111111111' };
    mockMemberships = [{ organizacao_id: '11111111-1111-4111-8111-111111111111' }];
  });
});
