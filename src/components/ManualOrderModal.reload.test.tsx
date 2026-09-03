/** @vitest-environment jsdom */
/**
 * Ticket 30, fatia 3 — 4ª e 5ª rodadas de revisão.
 *
 * **4ª rodada.** A referência local de idempotência não pode viver só num
 * `useRef`: um reload da página inteira (ou o modal fechando e reabrindo
 * depois de um resultado indeterminado) destrói a instância do componente, e
 * uma retentativa com uma referência NOVA faria o ledger do servidor tratá-la
 * como uma tentativa genuinamente nova — liberando uma segunda chamada a
 * `POST /pedidos/vendas` no Bling para uma venda que já podia estar em voo.
 * `unmount()` é o proxy mais direto disponível em RTL para "a página
 * recarregou".
 *
 * **5ª rodada.** Sobreviver ao reload não basta se a memória for um slot só e
 * global. A revisão pediu para delimitar o armazenamento, e estes testes
 * fixam os três eixos:
 *
 * - **organização**: uma venda feita na organização B não pode apagar a
 *   pendência da organização A — se apagasse, a retentativa em A geraria
 *   referência nova e o ledger a trataria como tentativa nova;
 * - **conteúdo**: uma venda genuinamente DIFERENTE ganha referência nova, em
 *   vez de reutilizar a da pendência anterior (que o servidor recusaria como
 *   conflito);
 * - **ciclo de vida**: a referência só é esquecida com desfecho conhecido.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { act } from 'react';

const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

vi.mock('@/lib/supabaseClient', () => ({
  supabase: {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: { access_token: 'token-teste' } } }),
    },
  },
}));

const chamadasFetch: Array<{ body: Record<string, unknown> }> = [];
/** Quando `true`, a rota responde sucesso; senão, o desfecho indeterminado. */
let responderSucesso = false;

vi.mock('@/lib/fetchWithAuth', () => ({
  fetchWithAuth: vi.fn(async (_url: string, options: RequestInit) => {
    const body = JSON.parse(String(options.body)) as Record<string, unknown>;
    chamadasFetch.push({ body });
    if (responderSucesso) {
      return { ok: true, json: async () => ({ success: true, pedidoId: 'pedido-1', blingPedidoId: '918273' }) } as Response;
    }
    // Falha ambígua/indeterminada — o cenário em que a referência precisa
    // sobreviver.
    return {
      ok: false,
      json: async () => ({
        error: 'Não foi possível confirmar se a venda foi registrada.',
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
    organizacaoId: ORG_A,
    ...overrides,
  };
}

/** Renderiza o hook, submete uma vez e desmonta — o proxy de "recarregou". */
async function submeterEDescartar(overrides: Partial<Parameters<typeof useManualOrderSubmit>[0]> = {}) {
  const instancia = renderHook(() => useManualOrderSubmit(inputPadrao(overrides)));
  await act(async () => {
    await instancia.result.current.handleSubmit();
  });
  instancia.unmount();
}

function ultimaReferenciaEnviada(): unknown {
  return chamadasFetch[chamadasFetch.length - 1].body.referenciaLocal;
}

describe('useManualOrderSubmit — a referência sobrevive, e sobrevive delimitada', () => {
  beforeEach(() => {
    chamadasFetch.length = 0;
    responderSucesso = false;
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it('a MESMA referenciaLocal é reenviada depois de desmontar e remontar (proxy de reload)', async () => {
    await submeterEDescartar();
    const referenciaOriginal = ultimaReferenciaEnviada();
    expect(typeof referenciaOriginal).toBe('string');

    // Instância NOVA, do zero — como o componente apareceria numa página
    // recarregada. Um `useRef` morre aqui; a memória escopada não.
    await submeterEDescartar();

    expect(chamadasFetch).toHaveLength(2);
    expect(ultimaReferenciaEnviada()).toBe(referenciaOriginal);
  });

  it('um sucesso real esquece a referência — a PRÓXIMA venda igual ganha uma nova', async () => {
    responderSucesso = true;
    await submeterEDescartar();
    const referenciaConcluida = ultimaReferenciaEnviada();

    await submeterEDescartar();

    expect(chamadasFetch).toHaveLength(2);
    // Uma venda nova é uma operação nova, mesmo com o mesmo conteúdo: a
    // anterior já terminou, e reutilizar a chave dela faria o servidor
    // devolver o resultado antigo em vez de registrar esta.
    expect(ultimaReferenciaEnviada()).not.toBe(referenciaConcluida);
  });

  it('uma venda DIFERENTE não reutiliza a referência da pendência anterior', async () => {
    await submeterEDescartar();
    const referenciaDaPrimeira = ultimaReferenciaEnviada();

    // Mesma organização, conteúdo diferente — o cenário que o servidor
    // recusaria como conflito se a referência fosse reaproveitada.
    await submeterEDescartar({ itens: [{ ...ITEM, quantidade: 3 }] });

    expect(ultimaReferenciaEnviada()).not.toBe(referenciaDaPrimeira);
  });

  it('e a pendência da primeira venda CONTINUA lembrada — a segunda não apagou a âncora da primeira', async () => {
    await submeterEDescartar();
    const referenciaDaPrimeira = ultimaReferenciaEnviada();

    await submeterEDescartar({ itens: [{ ...ITEM, quantidade: 3 }] });

    // Retentar a PRIMEIRA venda ainda reencontra a referência dela. Sem isto,
    // a tentativa original ficaria sem âncora: irreconciliável, e uma
    // retentativa criaria um segundo pedido.
    await submeterEDescartar();
    expect(ultimaReferenciaEnviada()).toBe(referenciaDaPrimeira);
  });

  it('TROCA DE ORGANIZAÇÃO: vender em B não apaga a pendência de A', async () => {
    await submeterEDescartar({ organizacaoId: ORG_A });
    const referenciaEmA = ultimaReferenciaEnviada();

    // A MESMA venda, na organização B: é outro ledger, então é outra
    // tentativa — referência própria.
    await submeterEDescartar({ organizacaoId: ORG_B });
    expect(ultimaReferenciaEnviada()).not.toBe(referenciaEmA);

    // De volta para A: a pendência de A continua lá, intacta.
    await submeterEDescartar({ organizacaoId: ORG_A });
    expect(ultimaReferenciaEnviada()).toBe(referenciaEmA);
  });

  it('sem organização confirmada, nada é lembrado entre instâncias — degradação honesta, nunca chave adivinhada', async () => {
    await submeterEDescartar({ organizacaoId: null });
    const primeira = ultimaReferenciaEnviada();

    await submeterEDescartar({ organizacaoId: null });

    expect(ultimaReferenciaEnviada()).not.toBe(primeira);
    // E não deixou nada gravado sob nenhuma chave.
    expect(window.localStorage.length).toBe(0);
  });

  it('dentro da MESMA instância, a retentativa reusa a referência mesmo sem organização', async () => {
    const instancia = renderHook(() => useManualOrderSubmit(inputPadrao({ organizacaoId: null })));
    await act(async () => {
      await instancia.result.current.handleSubmit();
    });
    const primeira = ultimaReferenciaEnviada();
    await act(async () => {
      await instancia.result.current.handleSubmit();
    });

    // A camada em memória cobre o caso de `localStorage` indisponível: a
    // proteção volta a valer só dentro da instância, mas não desaparece.
    expect(ultimaReferenciaEnviada()).toBe(primeira);
    instancia.unmount();
  });
});
