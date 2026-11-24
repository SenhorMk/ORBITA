/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';

import { createDespesaHandler } from '@/app/api/financeiro/despesaHandler';
import { fakeBling } from '@/app/api/financeiro/__testkit__/blingContasPagarFake';
import { depsDeTeste, fakeStore } from '@/app/api/financeiro/__testkit__/despesaFakes';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';

import { LancamentoDeDespesa } from './LancamentoDeDespesa';
import type { BuscaAutenticada } from './useLeituraFinanceira';

/**
 * PRE-001 no formulário: a chave da operação nasce no navegador antes da rede,
 * volta igual em toda retentativa do mesmo lançamento, e um resultado não
 * confirmado não deixa o mesmo diálogo lançar de novo.
 */

const REF = '55555555-5555-4555-8555-555555555555';
const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '44444444-4444-4444-8444-444444444444';
/** SAFETY: o escopo é entrada do teste, não o que está sob teste. */
const scopeA = { organizationId: ORG_A, actorId: '22222222-2222-4222-8222-222222222222', role: 'owner' } as unknown as VerifiedOrganizationScope;

function json(status: number, corpo: unknown): Response {
  return new Response(JSON.stringify(corpo), { status, headers: { 'Content-Type': 'application/json' } });
}

/** `fetchWithAuth` fake: fornecedores vazios, e o POST responde o que o teste programar. */
function servidor(...respostasDoPost: Array<Response | Error>) {
  const posts: Array<Record<string, unknown>> = [];
  const busca: BuscaAutenticada = async (url, options) => {
    if (url === '/api/financeiro/fornecedores') return json(200, { success: true, data: [] });
    posts.push(JSON.parse(String(options?.body)) as Record<string, unknown>);
    const proxima = respostasDoPost.shift() ?? json(500, { success: false, error: 'sem resposta programada' });
    if (proxima instanceof Error) throw proxima;
    return proxima;
  };
  return { busca, posts };
}

function Montado({ busca, onSalvo = () => {}, organizacaoId = ORG_A }: {
  busca: BuscaAutenticada;
  onSalvo?: () => void;
  organizacaoId?: string;
}) {
  const [syncing, setSyncing] = useState(false);
  return (
    <LancamentoDeDespesa
      fetchWithAuth={busca}
      categorias={[]}
      aberto
      onFechar={() => {}}
      onSalvo={onSalvo}
      syncing={syncing}
      setSyncing={setSyncing}
      organizacaoId={organizacaoId}
    />
  );
}

async function preencherEEnviar(descricao = 'Aluguel') {
  const campoDescricao = screen.getByLabelText('Descrição do Gasto');
  await userEvent.clear(campoDescricao);
  await userEvent.type(campoDescricao, descricao);
  if ((screen.getByLabelText('Título') as HTMLInputElement).value === '') {
    await userEvent.type(screen.getByLabelText('Título'), 'Aluguel');
    await userEvent.type(screen.getByLabelText('Valor (R$)'), '1200');
    // `userEvent.type` não preenche `type="date"` no jsdom.
    fireEvent.change(screen.getByLabelText('Data Vencimento'), { target: { value: '2026-09-10' } });
  }
  await userEvent.click(screen.getByRole('button', { name: /^(Registrar saída|Registrando\.\.\.)$/i }));
}

let alerta: ReturnType<typeof vi.fn>;
beforeEach(() => {
  window.sessionStorage.clear();
  alerta = vi.fn();
  vi.stubGlobal('alert', alerta);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PRE-001 — o formulário diante de um resultado não confirmado', () => {
  it('não confirmado: mostra o motivo e não deixa lançar de novo pelo mesmo diálogo', async () => {
    const { busca, posts } = servidor(json(202, {
      success: false,
      error: 'O Bling não confirmou o resultado deste lançamento. Não lance de novo.',
      operacao: { ref: REF, estado: 'indeterminada' },
    }));
    render(<Montado busca={busca} />);

    await preencherEEnviar();

    expect(await screen.findByRole('status')).toHaveTextContent('Não lance de novo');
    const botao = screen.getByRole('button', { name: 'Registrar saída' });
    expect(botao).toBeDisabled();
    await userEvent.click(botao);
    expect(posts).toHaveLength(1);
  });

  it('a resposta se perdeu no caminho: a retentativa leva a MESMA chave', async () => {
    const onSalvo = vi.fn();
    const { busca, posts } = servidor(
      new TypeError('Failed to fetch'),
      json(200, { success: true, operacao: { ref: REF, estado: 'confirmada' } }),
    );
    render(<Montado busca={busca} onSalvo={onSalvo} />);

    await preencherEEnviar();
    await waitFor(() => expect(alerta).toHaveBeenCalledWith(expect.stringContaining('mesma operação')));
    await preencherEEnviar();

    await waitFor(() => expect(onSalvo).toHaveBeenCalled());
    expect(posts).toHaveLength(2);
    expect(posts[0]!.chaveIdempotencia).toEqual(expect.any(String));
    expect(posts[1]!.chaveIdempotencia).toBe(posts[0]!.chaveIdempotencia);
  });

  it('recusa definitiva: corrigir e enviar de novo é uma operação nova, com chave nova', async () => {
    const { busca, posts } = servidor(
      json(400, { success: false, error: 'O Bling recusou o lançamento', operacao: { ref: REF, estado: 'recusada' } }),
      json(200, { success: true }),
    );
    render(<Montado busca={busca} />);

    await preencherEEnviar();
    await waitFor(() => expect(alerta).toHaveBeenCalledWith(expect.stringContaining('recusou')));
    await preencherEEnviar();

    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]!.chaveIdempotencia).not.toBe(posts[0]!.chaveIdempotencia);
  });

  it('o lançamento só interno não leva chave: não há efeito externo a proteger', async () => {
    const { busca, posts } = servidor(json(200, { success: true }));
    render(<Montado busca={busca} />);

    await userEvent.click(screen.getByRole('button', { name: /Somente Interno/i }));
    await preencherEEnviar();

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.chaveIdempotencia).toBeUndefined();
  });
});

const RESPOSTA_PERDIDA = () => new TypeError('Failed to fetch');
const CONFIRMADA = () => json(200, { success: true, operacao: { ref: REF, estado: 'confirmada' } });

async function esperarAlerta(trecho: string) {
  await waitFor(() => expect(alerta).toHaveBeenCalledWith(expect.stringContaining(trecho)));
}

describe('PRE-001 — a chave sobrevive a reload', () => {
  it('servidor confirmou, resposta ao navegador perdida, página remonta: o mesmo lançamento NÃO cria segunda conta', async () => {
    // O handler REAL, com o Bling e o banco fakes: o servidor conclui o
    // pedido inteiro — Bling cria, tentativa `confirmada`, título gravado, 200
    // pronto — e só então a resposta se perde no caminho até o navegador.
    const bling = fakeBling();
    const store = fakeStore();
    const handler = createDespesaHandler(depsDeTeste(scopeA, { bling, store }));
    let perderAProximaResposta = true;
    const busca: BuscaAutenticada = async (url, options) => {
      if (url === '/api/financeiro/fornecedores') return json(200, { success: true, data: [] });
      const resposta = await handler(new Request('https://orbita.test/api/financeiro', {
        method: 'POST', headers: options?.headers, body: options?.body,
      }));
      if (perderAProximaResposta) {
        perderAProximaResposta = false;
        expect(resposta.status).toBe(200);
        throw RESPOSTA_PERDIDA();
      }
      return resposta;
    };

    const antes = render(<Montado busca={busca} />);
    await preencherEEnviar();
    await esperarAlerta('mesma operação');
    expect(store.tentativas.map((t) => t.estado)).toEqual(['confirmada']);

    antes.unmount();
    const onSalvo = vi.fn();
    render(<Montado busca={busca} onSalvo={onSalvo} />);
    await preencherEEnviar();
    await waitFor(() => expect(onSalvo).toHaveBeenCalled());

    expect(bling.contasCriadasNoBling()).toBe(1);
    expect(bling.posts).toHaveLength(1);
    expect(store.tentativas).toHaveLength(1);
  });

  it('refresh mantém a mesma operação', async () => {
    const { busca, posts } = servidor(RESPOSTA_PERDIDA(), CONFIRMADA());

    const antes = render(<Montado busca={busca} />);
    await preencherEEnviar();
    await esperarAlerta('mesma operação');
    antes.unmount();
    render(<Montado busca={busca} />);
    await preencherEEnviar();

    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]!.chaveIdempotencia).toBe(posts[0]!.chaveIdempotencia);
  });

  it('o sessionStorage guarda só a impressão do conteúdo e o UUID, nunca a despesa', async () => {
    const { busca } = servidor(RESPOSTA_PERDIDA());
    render(<Montado busca={busca} />);
    await preencherEEnviar('Pagamento ao fornecedor secreto');
    await esperarAlerta('mesma operação');

    const guardado = Object.entries({ ...window.sessionStorage });
    expect(guardado).toHaveLength(1);
    const [nome, valor] = guardado[0]!;
    expect(nome).toMatch(new RegExp(`^orbita\.despesa\.operacao\.${ORG_A}\.[0-9a-f]{64}$`, 'u'));
    expect(valor).toMatch(/^[0-9a-f-]{36}$/u);
    expect(nome + valor).not.toContain('secreto');
    expect(nome + valor).not.toContain('1200');
  });

  it('resposta definitiva limpa a associação: o mesmo conteúdo, depois, é operação nova', async () => {
    const { busca, posts } = servidor(CONFIRMADA(), CONFIRMADA());
    render(<Montado busca={busca} />);

    await preencherEEnviar();
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(window.sessionStorage.length).toBe(0);
    await preencherEEnviar();

    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]!.chaveIdempotencia).not.toBe(posts[0]!.chaveIdempotencia);
  });

  it('conteúdo diferente recebe operação diferente', async () => {
    const { busca, posts } = servidor(RESPOSTA_PERDIDA(), CONFIRMADA());
    render(<Montado busca={busca} />);

    await preencherEEnviar('Aluguel');
    await esperarAlerta('mesma operação');
    await preencherEEnviar('Aluguel de outubro');

    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]!.chaveIdempotencia).not.toBe(posts[0]!.chaveIdempotencia);
  });

  it('organização diferente não compartilha operação', async () => {
    const { busca, posts } = servidor(RESPOSTA_PERDIDA(), CONFIRMADA(), CONFIRMADA());

    const emA = render(<Montado busca={busca} organizacaoId={ORG_A} />);
    await preencherEEnviar();
    await esperarAlerta('mesma operação');
    emA.unmount();
    const emB = render(<Montado busca={busca} organizacaoId={ORG_B} />);
    await preencherEEnviar();
    await waitFor(() => expect(posts).toHaveLength(2));
    emB.unmount();
    // De volta à organização A, a operação dela continua lá.
    render(<Montado busca={busca} organizacaoId={ORG_A} />);
    await preencherEEnviar();

    await waitFor(() => expect(posts).toHaveLength(3));
    expect(posts[1]!.chaveIdempotencia).not.toBe(posts[0]!.chaveIdempotencia);
    expect(posts[2]!.chaveIdempotencia).toBe(posts[0]!.chaveIdempotencia);
  });
});

/**
 * O formulário real falando com o handler real (Bling e banco fakes), com a
 * entrega da próxima resposta ao navegador programável.
 */
function servidorReal() {
  const bling = fakeBling();
  const store = fakeStore();
  const handler = createDespesaHandler(depsDeTeste(scopeA, { bling, store }));
  const chamadasDaApi: unknown[] = [];
  let entregar: (resposta: Response) => Response = (resposta) => resposta;
  const busca: BuscaAutenticada = async (url, options) => {
    if (url === '/api/financeiro/fornecedores') return json(200, { success: true, data: [] });
    chamadasDaApi.push((JSON.parse(String(options?.body)) as Record<string, unknown>).chaveIdempotencia);
    const resposta = await handler(new Request('https://orbita.test/api/financeiro', {
      method: 'POST', headers: options?.headers, body: options?.body,
    }));
    const entrega = entregar;
    entregar = (r) => r;
    return entrega(resposta);
  };
  return {
    busca, bling, store, chamadasDaApi,
    aoEntregarAProxima: (f: (resposta: Response) => Response) => { entregar = f; },
  };
}

describe('PRE-001 — sem storage persistente, o lançamento contábil não sai (falha fechada)', () => {
  it.each([
    ['setItem lança (cota cheia, aba privada)', () => vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('cota esgotada', 'QuotaExceededError');
    })],
    ['sessionStorage inacessível', () => vi.spyOn(window, 'sessionStorage', 'get').mockImplementation(() => {
      throw new DOMException('bloqueado', 'SecurityError');
    })],
    ['grava sem erro mas não relê o mesmo UUID', () => vi.spyOn(Storage.prototype, 'getItem').mockReturnValue(null)],
  ])('%s: zero chamadas à API, zero POST no Bling, nenhuma tentativa — e volta a funcionar com o storage', async (_caso, quebrar) => {
    const { busca, bling, store, chamadasDaApi } = servidorReal();
    const onSalvo = vi.fn();
    render(<Montado busca={busca} onSalvo={onSalvo} />);

    const espiao = quebrar();
    await preencherEEnviar();
    await esperarAlerta('não conseguiu guardar a identidade segura');

    expect(chamadasDaApi).toHaveLength(0);
    expect(bling.posts).toHaveLength(0);
    expect(bling.contasCriadasNoBling()).toBe(0);
    expect(store.tentativas).toHaveLength(0);
    expect(onSalvo).not.toHaveBeenCalled();

    espiao.mockRestore();
    await preencherEEnviar();

    await waitFor(() => expect(onSalvo).toHaveBeenCalled());
    expect(chamadasDaApi).toHaveLength(1);
    expect(bling.contasCriadasNoBling()).toBe(1);
  });
});

describe('PRE-001 — 200 com corpo ilegível não encerra a operação', () => {
  it('servidor conclui, o navegador recebe 200 truncado, a retentativa usa a mesma chave: uma única conta', async () => {
    const { busca, bling, store, chamadasDaApi, aoEntregarAProxima } = servidorReal();
    aoEntregarAProxima(() => new Response('{"success":tr', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const onSalvo = vi.fn();
    render(<Montado busca={busca} onSalvo={onSalvo} />);

    await preencherEEnviar();
    await esperarAlerta('não pôde ser interpretada');
    expect(onSalvo).not.toHaveBeenCalled();
    expect(store.tentativas.map((t) => t.estado)).toEqual(['confirmada']);

    await preencherEEnviar();
    await waitFor(() => expect(onSalvo).toHaveBeenCalled());

    expect(chamadasDaApi).toHaveLength(2);
    expect(chamadasDaApi[1]).toBe(chamadasDaApi[0]);
    expect(bling.contasCriadasNoBling()).toBe(1);
    expect(bling.posts).toHaveLength(1);
  });
});
