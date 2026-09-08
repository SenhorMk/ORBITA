/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useMemo } from 'react';

import { useOrganizationsList } from '@/components/organizacao/useOrganizationsList';
import {
  usePapelNaOrganizacaoAtiva,
  type SelecaoDeOrganizacao,
} from '@/components/organizacao/usePapelNaOrganizacaoAtiva';
import type { AuthenticatedFetch } from '@/components/organizacao/useOrganizationPanel';
import { useLeituraDoPainel } from './useLeituraDoPainel';
import { fetchWithAuth } from '@/lib/fetchWithAuth';

/**
 * A composição que `page.tsx` faz — e a única coisa que ela precisa garantir.
 *
 * Os hooks estão certos cada um sozinho: a lista sabe qual é a organização
 * ativa, o papel se invalida na troca, e a leitura do painel recusa dado de
 * outro escopo. A pergunta que só a composição responde é **de onde sai o
 * escopo**, e ela já esteve errada: a seleção vinha de um anúncio do painel de
 * organização por efeito, que chega um render depois da fonte compartilhada.
 *
 * O sintoma não é um estado final errado — a tela converge. É um render inteiro,
 * com paint, em que o topo escreve "Loja B" e os números embaixo ainda são da
 * Loja A. Por isso este teste não olha o desfecho: ele grava **todos** os
 * renders e afirma que nenhum deles mistura as duas organizações.
 */

vi.mock('@/lib/fetchWithAuth', () => ({ fetchWithAuth: vi.fn() }));

const ANA = 'ana@exemplo.com';
const ORG_A = { id: 'org-a', nome: 'Loja A', slug: 'loja-a' };
const ORG_B = { id: 'org-b', nome: 'Loja B', slug: 'loja-b' };

function resposta(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function painelDe(numero: string) {
  return {
    success: true,
    data: {
      pedidos: [{ id: numero, numero, total: 40, status: 'Entregue' }],
      produtos: [],
      clientes: [],
      estatisticas: {
        faturamento30Dias: 40,
        faturamento30DiasAnterior: 0,
        totalPedidos: 1,
        pendentes: 0,
        cancelados: 0,
        atendidos: 1,
      },
    },
  };
}

/** O que a tela mostrava em cada render. */
interface Quadro {
  readonly fonteAtiva: string | null;
  readonly selecao: string | null;
  readonly pedidoVisivel: string | null;
  readonly organizacaoConfirmada: string | null;
}

/**
 * A mesma composição de `page.tsx`: a lista compartilhada, a seleção derivada
 * dela **durante a renderização**, a autoridade sobre papel e a leitura do
 * painel — todas alimentadas por essa seleção.
 */
function Sonda({ identidade, quadros }: { identidade: string | null; quadros: Quadro[] }) {
  const lista = useOrganizationsList(fetchWithAuth as unknown as AuthenticatedFetch, identidade);

  const organizacaoAtivaId = lista.activeOrg?.organizacao.id ?? null;
  const versaoDaSelecao = lista.selectionVersion;
  const selecao = useMemo<SelecaoDeOrganizacao | null>(
    () => (organizacaoAtivaId === null ? null : { id: organizacaoAtivaId, versao: versaoDaSelecao }),
    [organizacaoAtivaId, versaoDaSelecao],
  );

  const { organizacaoId: organizacaoConfirmada } = usePapelNaOrganizacaoAtiva(
    fetchWithAuth as unknown as AuthenticatedFetch,
    identidade,
    selecao,
  );

  const escopo = identidade === null
    ? null
    : `${identidade}|${selecao ? `${selecao.id}:${selecao.versao}` : 'sem-organizacao'}`;
  const painel = useLeituraDoPainel(escopo);

  quadros.push({
    fonteAtiva: organizacaoAtivaId,
    selecao: selecao?.id ?? null,
    pedidoVisivel: painel.dados?.pedidos[0]?.numero ?? null,
    organizacaoConfirmada,
  });

  return (
    <div>
      <span data-testid="fonte">{lista.activeOrg?.organizacao.nome ?? '(nenhuma)'}</span>
      <span data-testid="selecao">{selecao?.id ?? '(nenhuma)'}</span>
      <span data-testid="pedido">{painel.dados?.pedidos[0]?.numero ?? '(nenhum)'}</span>
      <span data-testid="confirmada">{organizacaoConfirmada ?? '(nenhuma)'}</span>
      {lista.organizacoes.map((org) => (
        <button key={org.id} type="button" onClick={() => { void lista.handleSwitchOrganization(org.id); }}>
          {`trocar para ${org.nome}`}
        </button>
      ))}
    </div>
  );
}

/** A fronteira de rede: organizações, papel e painel, por organização ativa. */
function construirFetch() {
  let ativa = ORG_A;
  let versao = 3;
  const pedidoPorOrganizacao: Record<string, string> = { 'org-a': '20', 'org-b': '99' };

  const fn = vi.fn(async (url: string, options: RequestInit = {}) => {
    const metodo = options.method ?? 'GET';

    if (metodo === 'GET' && url === '/api/organizacoes') {
      return resposta({
        organizacoes: [ORG_A, ORG_B],
        activeOrg: { organizacao: ativa, papel: 'owner' },
        selectionVersion: versao,
      });
    }
    if (metodo === 'POST' && url === '/api/organizacoes/switch') {
      const corpo = JSON.parse(String(options.body)) as { organizacao_id: string };
      ativa = corpo.organizacao_id === ORG_B.id ? ORG_B : ORG_A;
      versao += 1;
      return resposta({ activeOrg: { organizacao: ativa, papel: 'owner' }, selectionVersion: versao });
    }
    if (metodo === 'GET' && url === '/api/dashboard') {
      return resposta(painelDe(pedidoPorOrganizacao[ativa.id]));
    }
    throw new Error(`Requisição não prevista: ${metodo} ${url}`);
  });

  return fn;
}

beforeEach(() => vi.clearAllMocks());

describe('a organização ativa e o escopo operacional andam no mesmo render', () => {
  it('nenhum render mistura a organização do topo com os dados da anterior', async () => {
    vi.mocked(fetchWithAuth).mockImplementation(construirFetch());
    const quadros: Quadro[] = [];

    render(<Sonda identidade={ANA} quadros={quadros} />);

    await waitFor(() => expect(screen.getByTestId('pedido')).toHaveTextContent('20'));
    await waitFor(() => expect(screen.getByTestId('confirmada')).toHaveTextContent('org-a'));

    await userEvent.click(screen.getByRole('button', { name: 'trocar para Loja B' }));

    await waitFor(() => expect(screen.getByTestId('pedido')).toHaveTextContent('99'));

    // A afirmação inteira do teste: em NENHUM dos renders a fonte disse "org-b"
    // enquanto a seleção, o pedido na tela ou a organização confirmada ainda
    // eram de "org-a". A tela convergir no fim não basta — o defeito é o render
    // do meio, que a pessoa vê.
    const misturados = quadros.filter((q) => q.fonteAtiva === 'org-b'
      && (q.selecao === 'org-a' || q.pedidoVisivel === '20' || q.organizacaoConfirmada === 'org-a'));

    expect(misturados).toEqual([]);
    // E o caminho realmente foi percorrido: houve render com a fonte em B.
    expect(quadros.some((q) => q.fonteAtiva === 'org-b')).toBe(true);
  });

  it('a seleção efetiva vira B no mesmo render em que a fonte vira B', async () => {
    vi.mocked(fetchWithAuth).mockImplementation(construirFetch());
    const quadros: Quadro[] = [];

    render(<Sonda identidade={ANA} quadros={quadros} />);
    await waitFor(() => expect(screen.getByTestId('fonte')).toHaveTextContent('Loja A'));

    await userEvent.click(screen.getByRole('button', { name: 'trocar para Loja B' }));
    await waitFor(() => expect(screen.getByTestId('fonte')).toHaveTextContent('Loja B'));

    const primeiroComB = quadros.find((q) => q.fonteAtiva === 'org-b');
    expect(primeiroComB?.selecao).toBe('org-b');
    // Nesse mesmo render a leitura de A já não é elegível: a tela entra em
    // carregando para o escopo novo em vez de mostrar o tenant anterior.
    expect(primeiroComB?.pedidoVisivel).toBeNull();
  });
});
