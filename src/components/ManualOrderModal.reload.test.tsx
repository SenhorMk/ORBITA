/** @vitest-environment jsdom */
/**
 * Ticket 30, fatia 3 — 4ª rodada de revisão.
 *
 * A referência local de idempotência não pode viver só num `useRef`: um
 * reload da página inteira (ou o modal fechando e reabrindo depois de um
 * resultado indeterminado) destrói a instância do componente, e uma
 * retentativa com uma referência NOVA faria o ledger do servidor tratá-la
 * como uma tentativa genuinamente nova — liberando uma segunda chamada a
 * `POST /pedidos/vendas` no Bling para uma venda que já podia estar em voo.
 *
 * Este teste PROVA a sobrevivência: `useManualOrderSubmit` é desmontado por
 * completo (`unmount()`) — o proxy mais direto disponível em RTL para "a
 * página recarregou" — e remontado do zero, como uma nova instância do
 * componente veria o mundo depois de um reload real. A segunda instância
 * tem de reenviar a MESMA `referenciaLocal` que a primeira usou.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { act } from 'react';

vi.mock('@/lib/supabaseClient', () => ({
  supabase: {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: { access_token: 'token-teste' } } }),
    },
  },
}));

const chamadasFetch: Array<{ body: Record<string, unknown> }> = [];

vi.mock('@/lib/fetchWithAuth', () => ({
  fetchWithAuth: vi.fn(async (_url: string, options: RequestInit) => {
    const body = JSON.parse(String(options.body)) as Record<string, unknown>;
    chamadasFetch.push({ body });
    // Sempre devolve uma falha ambígua/indeterminada — o cenário exato em
    // que a revisão pediu para provar que a referência sobrevive.
    return {
      ok: false,
      json: async () => ({
        error: 'Não foi possível confirmar se a venda foi registrada. NÃO tente de novo e NÃO cancele o pedido no Bling agora.',
        estadoIndeterminado: true,
        blingPedidoId: '918273',
      }),
    } as Response;
  }),
}));

const { useManualOrderSubmit } = await import('./useManualOrderSubmit');

const ITEM = {
  produto_id: '55555555-5555-4555-8555-555555555555',
  bling_id: '77',
  nome: 'Produto Teste',
  quantidade: 1,
  max_quantidade: 5,
  valor_unitario: 10,
};

function inputPadrao(overrides: Partial<Parameters<typeof useManualOrderSubmit>[0]> = {}) {
  return {
    syncBling: true,
    selectedCliente: '44444444-4444-4444-8444-444444444444',
    formaPagamento: 'Dinheiro',
    desconto: '' as const,
    frete: '' as const,
    observacoes: '',
    itens: [ITEM],
    setError: vi.fn(),
    onOpenChange: vi.fn(),
    resetForm: vi.fn(),
    ...overrides,
  };
}

describe('useManualOrderSubmit — referência sobrevive a um reload real', () => {
  beforeEach(() => {
    chamadasFetch.length = 0;
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it('a MESMA referenciaLocal é reenviada depois de desmontar e remontar o hook (proxy de reload)', async () => {
    // ---- "Antes do reload": primeira submissão, resultado indeterminado. ----
    const primeiraInstancia = renderHook(() => useManualOrderSubmit(inputPadrao()));
    await act(async () => {
      await primeiraInstancia.result.current.handleSubmit();
    });

    expect(chamadasFetch).toHaveLength(1);
    const referenciaDaPrimeiraTentativa = chamadasFetch[0].body.referenciaLocal;
    expect(typeof referenciaDaPrimeiraTentativa).toBe('string');
    expect(referenciaDaPrimeiraTentativa).toBeTruthy();

    // Confirma que ficou em localStorage — é isso que sobrevive ao reload.
    expect(window.localStorage.getItem('orbita:pedidos-manual:tentativa-pendente')).toBe(referenciaDaPrimeiraTentativa);

    // ---- O RELOAD: desmonta por completo. Um `useRef` morre aqui; localStorage não. ----
    primeiraInstancia.unmount();

    // ---- "Depois do reload": uma instância NOVA, do zero — exatamente como
    // o componente apareceria numa página recarregada. ----
    const segundaInstancia = renderHook(() => useManualOrderSubmit(inputPadrao()));
    await act(async () => {
      await segundaInstancia.result.current.handleSubmit();
    });

    expect(chamadasFetch).toHaveLength(2);
    const referenciaDaRetentativa = chamadasFetch[1].body.referenciaLocal;

    // O PONTO CENTRAL DO TESTE: a mesma identidade lógica de tentativa.
    expect(referenciaDaRetentativa).toBe(referenciaDaPrimeiraTentativa);
  });

  it('um sucesso real limpa a referência — a PRÓXIMA venda, mesmo depois de um reload, usa uma referência nova', async () => {
    vi.mocked((await import('@/lib/fetchWithAuth')).fetchWithAuth).mockImplementationOnce(async (_url, options) => {
      const body = JSON.parse(String((options as RequestInit).body)) as Record<string, unknown>;
      chamadasFetch.push({ body });
      return { ok: true, json: async () => ({ success: true, pedidoId: 'pedido-1', blingPedidoId: '918273' }) } as Response;
    });

    const instancia = renderHook(() => useManualOrderSubmit(inputPadrao()));
    await act(async () => {
      await instancia.result.current.handleSubmit();
    });

    // Sucesso real: nada deveria sobrar em localStorage.
    expect(window.localStorage.getItem('orbita:pedidos-manual:tentativa-pendente')).toBeNull();
    instancia.unmount();

    // Uma venda NOVA, depois de um reload, não deve reaproveitar a
    // referência da venda anterior (já concluída) — cada venda tem a sua.
    const proximaInstancia = renderHook(() => useManualOrderSubmit(inputPadrao()));
    await act(async () => {
      await proximaInstancia.result.current.handleSubmit();
    });

    expect(chamadasFetch).toHaveLength(2);
    expect(chamadasFetch[1].body.referenciaLocal).not.toBe(chamadasFetch[0].body.referenciaLocal);
  });
});
