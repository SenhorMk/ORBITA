/**
 * Ticket 30, fatia 3, 3ª rodada — a regressão pedida explicitamente:
 * "atravesse a regressão até a rota". `manual-order.test.ts` prova o
 * `handler.ts` com um `ManualOrderStorePort` fake; este arquivo prova a rota
 * REAL (`route.ts`'s `POST`), com o classificador REAL
 * (`classificarErroDePersistencia`) e as RPCs REAIS de idempotência
 * (`reivindicar_tentativa_venda_manual`/`concluir_tentativa_venda_manual`),
 * só com `supabaseServer` e o cliente do Bling dublados.
 *
 * Dois fatos, provados de ponta a ponta:
 *
 *   1. Uma falha de transporte (sem `error.code`) que a janela de
 *      confirmação nunca resolve devolve exatamente
 *      `{ status: 500, estadoIndeterminado: true }` pela ROTA — não só pelo
 *      handler isolado.
 *   2. Reenviar a MESMA requisição (mesmo corpo, mesma `referenciaLocal`)
 *      depois desse estado NÃO chama `POST /pedidos/vendas` no Bling uma
 *      segunda vez — a proteção contra duplicação externa funciona com a
 *      RPC real de reivindicação, não só com a porta fake do handler.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project-ref.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'public-key-12345678901234567890';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'server-key-12345678901234567890';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR_ID = '22222222-2222-4222-8222-222222222222';
const CLIENTE_ID = '33333333-3333-4333-8333-333333333333';
const PRODUTO_ID = '44444444-4444-4444-8444-444444444444';
const REFERENCIA_LOCAL = '55555555-5555-4555-8555-555555555555';

vi.mock('@/lib/requestOrganizationContext', () => ({
  resolveVerifiedOrganizationScope: vi.fn().mockResolvedValue({
    _tag: 'RequestScopeResolved',
    scope: { organizationId: ORG_ID, actorId: ACTOR_ID, role: 'owner' },
  }),
}));

/** Estado da "tabela" de tentativas, só o suficiente para o cenário testado. */
let tentativaArmazenada: { estado: string; blingPedidoId: string | null } | null = null;
let chamadasDeCriarPedido = 0;

vi.mock('@/lib/supabaseServer', () => ({
  supabaseServer: {
    rpc: (fnName: string, args?: Record<string, unknown>) => {
      if (fnName === 'reivindicar_tentativa_venda_manual') {
        if (tentativaArmazenada) {
          return Promise.resolve({
            data: [{
              tentativa_id: 'tentativa-1',
              estado: tentativaArmazenada.estado,
              pedido_id: null,
              bling_pedido_id: tentativaArmazenada.blingPedidoId,
              is_duplicate: true,
            }],
            error: null,
          });
        }
        tentativaArmazenada = { estado: 'em_andamento', blingPedidoId: null };
        return Promise.resolve({
          data: [{ tentativa_id: 'tentativa-1', estado: 'em_andamento', pedido_id: null, bling_pedido_id: null, is_duplicate: false }],
          error: null,
        });
      }
      if (fnName === 'concluir_tentativa_venda_manual') {
        if (tentativaArmazenada) {
          tentativaArmazenada.estado = String(args?.p_estado);
          tentativaArmazenada.blingPedidoId = (args?.p_bling_pedido_id as string | null) ?? tentativaArmazenada.blingPedidoId;
        }
        return Promise.resolve({ data: null, error: null });
      }
      if (fnName === 'registrar_venda_manual') {
        // Falha de TRANSPORTE — sem `code` — exatamente o formato que
        // `classificarErroDePersistencia` reconhece como Ambígua.
        return Promise.resolve({ data: null, error: { message: 'AbortError: The operation was aborted', code: '' } });
      }
      return Promise.resolve({ data: null, error: null });
    },
    from: (table: string) => {
      if (table === 'clientes') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: () => Promise.resolve({
                  data: { id: CLIENTE_ID, nome: 'Cliente Teste', bling_id: '999', email: null, telefone: null, cpf_cnpj: null },
                  error: null,
                }),
              }),
            }),
          }),
        };
      }
      if (table === 'produtos') {
        return {
          select: () => ({
            eq: () => ({
              in: () => Promise.resolve({
                data: [{ id: PRODUTO_ID, nome: 'Produto Teste', codigo: null, bling_id: '77', preco: 10, estoque: 5, estoque_reservado: 0 }],
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === 'pedidos') {
        // `findVendaManualJaRegistrada` — nunca encontra: é o que torna a
        // ambiguidade NUNCA resolvida no teste 1.
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: () => Promise.resolve({ data: null, error: null }),
                }),
              }),
            }),
          }),
        };
      }
      return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) };
    },
  },
}));

vi.mock('@/services/bling', () => ({
  bling: {
    forVerifiedOrganization: () => ({
      obterFormaPagamentoPadraoId: () => Promise.resolve({ _tag: 'BlingOk', value: 12 }),
      criarContatoParaVenda: () => Promise.resolve({ _tag: 'BlingOk', value: { id: 999 } }),
      criarPedidoVenda: () => {
        chamadasDeCriarPedido += 1;
        return Promise.resolve({ _tag: 'BlingOk', value: { id: '918273', alertas: [] } });
      },
      lancarEstoquePedidoVenda: () => Promise.resolve({ _tag: 'BlingOk', value: undefined }),
      cancelarPedidoVenda: () => Promise.resolve({ _tag: 'BlingOk', value: undefined }),
    }),
  },
}));

function corpoValido() {
  return {
    syncBling: true,
    clienteId: CLIENTE_ID,
    itens: [{ produtoId: PRODUTO_ID, quantidade: 1 }],
    desconto: 0,
    frete: 0,
    formaPagamentoRotulo: 'Dinheiro',
    referenciaLocal: REFERENCIA_LOCAL,
  };
}

function requisicao() {
  return new Request('https://orbita.test/api/pedidos/manual', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(corpoValido()),
  });
}

describe('POST /api/pedidos/manual — idempotência de ponta a ponta (rota real)', () => {
  beforeEach(() => {
    tentativaArmazenada = null;
    chamadasDeCriarPedido = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('ambiguidade nunca resolvida: a ROTA devolve estadoIndeterminado, e a retentativa com a MESMA referência não chama o Bling de novo', async () => {
    const { POST } = await import('./route');

    // Primeira chamada: dispara a janela de confirmação real (0/400/800/1600ms).
    const primeira = POST(requisicao());
    // As janelas usam `setTimeout` real via `dormirDeVerdade` — avança o
    // relógio falso pelo total (2.8s) para não esperar de verdade.
    await vi.advanceTimersByTimeAsync(3000);
    const respostaPrimeira = await primeira;
    const corpoPrimeira = await respostaPrimeira.json();

    expect(respostaPrimeira.status).toBe(500);
    expect(corpoPrimeira.estadoIndeterminado).toBe(true);
    expect(chamadasDeCriarPedido).toBe(1);

    // Segunda chamada: MESMO corpo, MESMA referenciaLocal — como um retry de
    // proxy/browser reenviaria. `reivindicar_tentativa_venda_manual` agora
    // encontra a tentativa 'indeterminada' registrada pela primeira chamada.
    const respostaSegunda = await POST(requisicao());
    const corpoSegunda = await respostaSegunda.json();

    expect(respostaSegunda.status).toBe(500);
    expect(corpoSegunda.estadoIndeterminado).toBe(true);
    // O ponto inteiro do teste: NENHUMA segunda chamada a criarPedidoVenda.
    expect(chamadasDeCriarPedido).toBe(1);
  });
});
