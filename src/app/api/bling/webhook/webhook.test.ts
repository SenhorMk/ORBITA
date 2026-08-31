import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import crypto from 'node:crypto';

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project-ref.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'public-key-12345678901234567890';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'server-key-12345678901234567890';
process.env.ENCRYPTION_KEY = 'ab'.repeat(32);

import { encrypt } from '../../../../lib/crypto';

const plainSecret = 'secret-bling-12345';
const ORG_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const CONEXAO_ID = '33333333-3333-4333-8333-333333333333';

let mockInboxResult = {
  evento_id: 'inbox-evt-1',
  status: 'received',
  is_duplicate: false,
  cached_response: null as Record<string, unknown> | null,
};

/** Conexões Bling visíveis ao webhook. Lista vazia simula "nenhuma organização conectou". */
let mockConexoes: Array<{ id: string; organizacao_id: string; provedor: string }> = [];
/** Dono da organização, ou `null` para simular organização sem dono. */
let mockOwnerId: string | null = OWNER_ID;

/** Estado do inbox por chave de idempotência, para exercitar reentrega. */
let mockInboxPorChave: Record<string, typeof mockInboxResult> = {};

const mockRpc = vi.fn().mockImplementation((fnName: string, args?: Record<string, unknown>) => {
  if (fnName === 'registrar_evento_inbox_bling') {
    const chave = String(args?.p_idempotency_key ?? '');
    return Promise.resolve({ data: [mockInboxPorChave[chave] ?? mockInboxResult], error: null });
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
      if (table === 'conexoes_integracao') {
        return {
          select: () => ({
            eq: (_col: string, provedor: string) =>
              Promise.resolve({ data: mockConexoes.filter((c) => c.provedor === provedor), error: null }),
          }),
        };
      }

      if (table === 'credenciais_integracao') {
        // Cifrado exatamente como o cofre grava em POST /api/bling/connect.
        const dadosCifrados = encrypt(JSON.stringify({ client_id: 'client-id', client_secret: plainSecret }));
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: () =>
                  Promise.resolve({ data: { dados_cifrados: dadosCifrados, chave_versao: 'v1' }, error: null }),
              }),
            }),
          }),
        };
      }

      if (table === 'membros_organizacao') {
        return {
          select: () => ({
            eq: () => ({
              // A segunda coluna distingue as duas consultas: `papel` resolve o
              // dono (ator do evento), `user_id` verifica o escopo organizacional.
              eq: (col: string) => {
                if (col === 'papel') {
                  const data = mockOwnerId ? { user_id: mockOwnerId } : null;
                  return {
                    limit: () => ({ maybeSingle: () => Promise.resolve({ data, error: null }) }),
                    maybeSingle: () => Promise.resolve({ data, error: null }),
                  };
                }
                return { maybeSingle: () => Promise.resolve({ data: { papel: 'owner' }, error: null }) };
              },
            }),
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

const mockMarkCancelled = vi.fn().mockResolvedValue(true);
const mockPedidoUpsert = vi.fn().mockResolvedValue({ id: 'ped-123' });

vi.mock('../../../../repositories/pedidoRepository', () => ({
  pedidoRepository: {
    upsert: (...args: unknown[]) => mockPedidoUpsert(...args),
    addItems: vi.fn().mockResolvedValue(undefined),
    markCancelledByBlingId: (...args: unknown[]) => mockMarkCancelled(...args),
  },
}));

function assinar(rawPayload: string): string {
  return `sha256=${crypto.createHmac('sha256', plainSecret).update(rawPayload).digest('hex')}`;
}

function requisicaoAssinada(rawPayload: string): NextRequest {
  return new NextRequest('https://orbita.test/api/bling/webhook', {
    method: 'POST',
    headers: { 'x-bling-signature-256': assinar(rawPayload), 'content-type': 'application/json' },
    body: rawPayload,
  });
}

describe('Bling Webhook Endpoint Security & Idempotent Inbox', () => {
  beforeAll(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project-ref.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'public-key-12345678901234567890';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'server-key-12345678901234567890';
    process.env.ENCRYPTION_KEY = 'ab'.repeat(32);
  });

  beforeEach(() => {
    mockConexoes = [{ id: CONEXAO_ID, organizacao_id: ORG_ID, provedor: 'bling' }];
    mockOwnerId = OWNER_ID;
    mockInboxResult = { evento_id: 'inbox-evt-1', status: 'received', is_duplicate: false, cached_response: null };
    mockInboxPorChave = {};
    mockMarkCancelled.mockClear();
    mockMarkCancelled.mockResolvedValue(true);
    mockPedidoUpsert.mockClear();
  });

  it('rejects webhook requests without signature header (fail-closed)', async () => {
    const { POST: webhookHandler } = await import('./route');
    const req = new NextRequest('https://orbita.test/api/bling/webhook', {
      method: 'POST',
      body: JSON.stringify({ event: 'order_updated', data: { id: 12345 } }),
    });

    const response = await webhookHandler(req);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ success: false, error: 'Assinatura ausente' });
  });

  it('rejects webhook requests with invalid or tampered signature', async () => {
    const { POST: webhookHandler } = await import('./route');
    const req = new NextRequest('https://orbita.test/api/bling/webhook', {
      method: 'POST',
      headers: { 'x-bling-signature-256': 'sha256=invalid-or-tampered-signature-123456' },
      body: JSON.stringify({ event: 'order_updated', data: { id: 12345 } }),
    });

    const response = await webhookHandler(req);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ success: false, error: 'Assinatura inválida' });
  });

  it('processes valid signed webhook event, registers in inbox and marks as processed', async () => {
    const { POST: webhookHandler } = await import('./route');
    const rawPayload = JSON.stringify({
      event: 'stock.updated',
      data: { idProduto: 'PROD-88', nome: 'Tenis Esportivo', preco: 299.9, saldoFisico: 15 },
    });

    const response = await webhookHandler(requisicaoAssinada(rawPayload));
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
      data: { idProduto: 'PROD-88', nome: 'Tenis Esportivo', preco: 299.9, saldoFisico: 15 },
    });

    const response = await webhookHandler(requisicaoAssinada(rawPayload));
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.processedProducts).toBe(1);
  });

  it('fails closed when no organization has connected the Bling (nothing to authenticate against)', async () => {
    mockConexoes = [];

    const { POST: webhookHandler } = await import('./route');
    const rawPayload = JSON.stringify({ event: 'stock.updated', data: { idProduto: 'PROD-99' } });

    const response = await webhookHandler(requisicaoAssinada(rawPayload));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ success: false, error: 'Assinatura inválida' });
  });

  it('fails closed when the connected organization has no owner to attribute the event to', async () => {
    mockOwnerId = null;

    const { POST: webhookHandler } = await import('./route');
    const rawPayload = JSON.stringify({ event: 'stock.updated', data: { idProduto: 'PROD-99' } });

    const response = await webhookHandler(requisicaoAssinada(rawPayload));
    expect(response.status).toBe(403);
    expect((await response.json()).success).toBe(false);
  });

  it('cancela o pedido local quando o Bling avisa que ele foi excluido, e nao o apaga', async () => {
    const { POST: webhookHandler } = await import('./route');
    const rawPayload = JSON.stringify({ event: 'order.deleted', data: { id: 987654 } });

    const response = await webhookHandler(requisicaoAssinada(rawPayload));
    expect(response.status).toBe(200);
    expect((await response.json()).success).toBe(true);

    expect(mockMarkCancelled).toHaveBeenCalledWith(expect.objectContaining({ organizationId: ORG_ID }), '987654');
    // A exclusão nunca passa pelo caminho de criação/atualização, que pediria
    // ao Bling um pedido que já não existe.
    expect(mockPedidoUpsert).not.toHaveBeenCalled();
  });

  it('trata exclusao de pedido que o ORBITA nunca conheceu sem falhar o evento', async () => {
    mockMarkCancelled.mockResolvedValue(false);

    const { POST: webhookHandler } = await import('./route');
    const rawPayload = JSON.stringify({ event: 'order.deleted', data: { id: 111222 } });

    const response = await webhookHandler(requisicaoAssinada(rawPayload));
    expect(response.status).toBe(200);
    expect((await response.json()).success).toBe(true);
    expect(mockMarkCancelled).toHaveBeenCalledWith(expect.anything(), '111222');
  });
});

/**
 * Recuperação de evento que falhou (ticket 11b).
 *
 * O defeito: um evento cujo efeito colateral estourava era marcado `failed` no
 * inbox e a rota respondia **200**. Para o Bling o evento estava entregue, não
 * havia nova tentativa, e não existe consumidor automático de replay — a
 * recuperação nunca acontecia. Era a diferença entre "o webhook fecha a volta"
 * e "o webhook fecha a volta quando dá tudo certo".
 */
describe('evento que falha é recuperado pela reentrega', () => {
  const PAYLOAD_EXCLUSAO = JSON.stringify({ event: 'order.deleted', data: { id: 987654 } });

  function statusDoInbox(): string | undefined {
    const chamada = mockRpc.mock.calls.find(
      ([nome, args]) => nome === 'concluir_evento_inbox_bling' && (args as Record<string, unknown>)?.p_status === 'failed',
    );
    return chamada ? String((chamada[1] as Record<string, unknown>).p_status) : undefined;
  }

  it('responde 503 quando o efeito colateral falha, em vez de 200', async () => {
    mockMarkCancelled.mockRejectedValue(new Error('conexão com o banco recusada'));

    const { POST: webhookHandler } = await import('./route');
    const response = await webhookHandler(requisicaoAssinada(PAYLOAD_EXCLUSAO));

    // Não-2xx é o que faz o Bling reentregar. Um 200 aqui encerraria o assunto
    // com o pedido cancelado no Bling e ativo no ORBITA, para sempre.
    expect(response.status).toBe(503);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(json.eventosComFalha).toEqual(['order.deleted_987654']);

    // E o evento fica `failed` no inbox, não `processed`.
    expect(statusDoInbox()).toBe('failed');
  });

  it('a reentrega reprocessa o evento failed e o pedido é cancelado', async () => {
    // Primeira entrega: falha.
    mockMarkCancelled.mockRejectedValue(new Error('conexão com o banco recusada'));
    const { POST: webhookHandler } = await import('./route');
    const primeira = await webhookHandler(requisicaoAssinada(PAYLOAD_EXCLUSAO));
    expect(primeira.status).toBe(503);

    // Reentrega: o inbox devolve o evento como duplicado com status `failed`.
    // Só `processed` é curto-circuitado, então este é reprocessado — é assim
    // que a recuperação acontece, sem consumidor de replay.
    mockInboxPorChave = {
      'order.deleted_987654': {
        evento_id: 'inbox-evt-1',
        status: 'failed',
        is_duplicate: true,
        cached_response: null,
      },
    };
    mockMarkCancelled.mockResolvedValue(true);

    const segunda = await webhookHandler(requisicaoAssinada(PAYLOAD_EXCLUSAO));

    expect(segunda.status).toBe(200);
    expect((await segunda.json()).success).toBe(true);
    expect(mockMarkCancelled).toHaveBeenLastCalledWith(
      expect.objectContaining({ organizationId: ORG_ID }),
      '987654',
    );
  });

  it('a reentrega não repete o efeito do evento que já tinha dado certo', async () => {
    const lote = JSON.stringify([
      { event: 'order.deleted', data: { id: 111 } },
      { event: 'order.deleted', data: { id: 222 } },
    ]);

    // Primeira entrega: o 111 passa, o 222 falha.
    mockMarkCancelled.mockImplementation(async (_escopo: unknown, blingId: string) => {
      if (blingId === '222') throw new Error('conexão com o banco recusada');
      return true;
    });

    const { POST: webhookHandler } = await import('./route');
    const primeira = await webhookHandler(requisicaoAssinada(lote));
    expect(primeira.status).toBe(503);
    expect((await primeira.json()).eventosComFalha).toEqual(['order.deleted_222']);

    // Reentrega do lote inteiro: o 111 volta como duplicado JÁ PROCESSADO e é
    // curto-circuitado; só o 222 roda de novo. Sem isso, cada reentrega
    // cancelaria de novo tudo o que já tinha dado certo.
    mockInboxPorChave = {
      'order.deleted_111': {
        evento_id: 'inbox-evt-111',
        status: 'processed',
        is_duplicate: true,
        cached_response: { success: true, processedProducts: 0 },
      },
      'order.deleted_222': {
        evento_id: 'inbox-evt-222',
        status: 'failed',
        is_duplicate: true,
        cached_response: null,
      },
    };
    mockMarkCancelled.mockClear();
    mockMarkCancelled.mockResolvedValue(true);

    const segunda = await webhookHandler(requisicaoAssinada(lote));

    expect(segunda.status).toBe(200);
    expect(mockMarkCancelled).toHaveBeenCalledTimes(1);
    expect(mockMarkCancelled).toHaveBeenCalledWith(expect.anything(), '222');
  });

  it('a reentrega age na organização que assinou, nunca em outra', async () => {
    // Duas organizações conectadas; só uma assina o evento.
    mockConexoes = [
      { id: CONEXAO_ID, organizacao_id: ORG_ID, provedor: 'bling' },
      { id: 'conexao-de-outra-org', organizacao_id: '99999999-9999-4999-8999-999999999999', provedor: 'bling' },
    ];
    mockInboxPorChave = {
      'order.deleted_987654': {
        evento_id: 'inbox-evt-1',
        status: 'failed',
        is_duplicate: true,
        cached_response: null,
      },
    };

    const { POST: webhookHandler } = await import('./route');
    const response = await webhookHandler(requisicaoAssinada(PAYLOAD_EXCLUSAO));

    expect(response.status).toBe(200);
    // O escopo vem da conexão que assinou, não do payload nem da ordem da lista.
    expect(mockMarkCancelled).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG_ID }),
      '987654',
    );
    expect(mockMarkCancelled).not.toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: '99999999-9999-4999-8999-999999999999' }),
      expect.anything(),
    );
  });
});
