// @vitest-environment jsdom
/**
 * O ciclo de vida da fonte compartilhada de organizações.
 *
 * Desde o Ticket 01 este estado vive no topo da aplicação, e não mais dentro do
 * painel de organização. Isso resolveu a divergência entre o indicador do shell
 * e a aba — e abriu um problema novo: o estado passou a **atravessar o logout**.
 *
 * Num shell multi-tenant, um tenant que sobrevive à sessão que o produziu é
 * exatamente o defeito que não se pode ter. Estes testes existem para as formas
 * de ele acontecer.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';

import { useOrganizationsList } from './useOrganizationsList';
import { usePapelNaOrganizacaoAtiva, type SelecaoDeOrganizacao } from './usePapelNaOrganizacaoAtiva';
import { useOrganizationPanel, type AuthenticatedFetch } from './useOrganizationPanel';

const ANA = 'ana@exemplo.com';
const BRUNO = 'bruno@exemplo.com';

const ORG_A = { id: '10000000-0000-4000-8000-00000000000a', nome: 'Loja A', slug: 'loja-a' };
const ORG_B = { id: '10000000-0000-4000-8000-00000000000b', nome: 'Loja B', slug: 'loja-b' };

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function corpoDe(org: typeof ORG_A, versao: number) {
  return { organizacoes: [org], activeOrg: { organizacao: org, papel: 'owner' }, selectionVersion: versao };
}

/** Uma resposta que o teste solta quando quiser — para segurar uma leitura em voo. */
function respostaControlada() {
  let soltar: (corpo: unknown) => void = () => {};
  const promessa = new Promise<Response>((resolver) => {
    soltar = (corpo) => resolver(jsonResponse(corpo));
  });
  return { promessa, soltar: (corpo: unknown) => soltar(corpo) };
}

/** Expõe o que o shell mostraria a partir do estado compartilhado. */
function Sonda({ fetchWithAuth, sessao }: { fetchWithAuth: AuthenticatedFetch; sessao: string | null }) {
  const lista = useOrganizationsList(fetchWithAuth, sessao);
  return (
    <div>
      <span data-testid="ativa">{lista.activeOrg?.organizacao.nome ?? '(nenhuma)'}</span>
      <span data-testid="organizacoes">{lista.organizacoes.map((o) => o.nome).join(',') || '(vazio)'}</span>
      <span data-testid="versao">{String(lista.selectionVersion)}</span>
      <span data-testid="erro">{lista.error ?? '(sem erro)'}</span>
      <span data-testid="trocando">{lista.switchingOrgId ?? '(nenhuma)'}</span>
    </div>
  );
}

function esperarAtiva(nome: string) {
  return waitFor(() => expect(screen.getByTestId('ativa')).toHaveTextContent(nome));
}

function conferirQueNadaSobrou() {
  expect(screen.getByTestId('ativa')).toHaveTextContent('(nenhuma)');
  expect(screen.getByTestId('organizacoes')).toHaveTextContent('(vazio)');
  expect(screen.getByTestId('versao')).toHaveTextContent('0');
  expect(screen.getByTestId('erro')).toHaveTextContent('(sem erro)');
  expect(screen.getByTestId('trocando')).toHaveTextContent('(nenhuma)');
}

describe('useOrganizationsList — o estado pertence à sessão', () => {
  it('A) perder a sessão não deixa nada da anterior exposto', async () => {
    const fetchWithAuth = vi.fn(async () => jsonResponse(corpoDe(ORG_A, 3))) as unknown as AuthenticatedFetch;
    const { rerender } = render(<Sonda fetchWithAuth={fetchWithAuth} sessao={ANA} />);

    await esperarAtiva('Loja A');

    rerender(<Sonda fetchWithAuth={fetchWithAuth} sessao={null} />);

    conferirQueNadaSobrou();
  });

  it('A2) o erro da sessão anterior também não sobrevive a ela', async () => {
    const fetchWithAuth = vi.fn(async () =>
      jsonResponse({ error: 'Falha ao carregar organizações' }, 500),
    ) as unknown as AuthenticatedFetch;
    const { rerender } = render(<Sonda fetchWithAuth={fetchWithAuth} sessao={ANA} />);

    await waitFor(() => expect(screen.getByTestId('erro')).toHaveTextContent('Falha ao carregar'));

    rerender(<Sonda fetchWithAuth={fetchWithAuth} sessao={null} />);

    expect(screen.getByTestId('erro')).toHaveTextContent('(sem erro)');
  });

  it('B) resposta atrasada da sessão anterior não repopula nada', async () => {
    const emVoo = respostaControlada();
    const fetchWithAuth = vi.fn(() => emVoo.promessa) as unknown as AuthenticatedFetch;

    const { rerender } = render(<Sonda fetchWithAuth={fetchWithAuth} sessao={ANA} />);
    // A leitura de Ana saiu e ainda não voltou.
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(1));

    rerender(<Sonda fetchWithAuth={fetchWithAuth} sessao={null} />);
    conferirQueNadaSobrou();

    // Só agora o servidor responde — com a organização de quem já saiu.
    await act(async () => {
      emVoo.soltar(corpoDe(ORG_A, 3));
      await emVoo.promessa;
    });

    conferirQueNadaSobrou();
    expect(screen.queryByText('Loja A')).not.toBeInTheDocument();
  });

  it('C) a sessão nova começa sem tenant herdado e só a resposta dela vale', async () => {
    const leituraDeAna = respostaControlada();
    const fetchWithAuth = vi
      .fn()
      .mockImplementationOnce(() => leituraDeAna.promessa)
      .mockImplementation(async () => jsonResponse(corpoDe(ORG_B, 7))) as unknown as AuthenticatedFetch;

    const { rerender } = render(<Sonda fetchWithAuth={fetchWithAuth} sessao={ANA} />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(1));

    // Bruno entra sem que a leitura de Ana tenha voltado. Antes da resposta
    // dele não há tenant nenhum na tela: nada foi herdado.
    rerender(<Sonda fetchWithAuth={fetchWithAuth} sessao={BRUNO} />);
    conferirQueNadaSobrou();

    await esperarAtiva('Loja B');

    // A resposta de Ana chega tarde, com Loja B já na tela. Continua não valendo.
    await act(async () => {
      leituraDeAna.soltar(corpoDe(ORG_A, 3));
      await leituraDeAna.promessa;
    });

    expect(screen.getByTestId('ativa')).toHaveTextContent('Loja B');
    expect(screen.getByTestId('organizacoes')).toHaveTextContent('Loja B');
    expect(screen.getByTestId('versao')).toHaveTextContent('7');
  });
});

/** O painel de organização, que em `page.tsx` só existe dentro da sessão. */
function PainelDaAba({
  fetchWithAuth,
  lista,
  onSelecao,
}: {
  fetchWithAuth: AuthenticatedFetch;
  lista: ReturnType<typeof useOrganizationsList>;
  onSelecao: (selecao: SelecaoDeOrganizacao | null) => void;
}) {
  useOrganizationPanel(fetchWithAuth, lista, onSelecao);
  return null;
}

/**
 * A seleção que alimenta `usePapelNaOrganizacaoAtiva`, montada como `page.tsx` a
 * monta: o estado compartilhado no topo, o painel **dentro** da sessão, e a
 * seleção valendo só enquanto durar a identidade que a produziu.
 *
 * O painel sair junto com a sessão é o ponto do teste. Ele é quem anuncia a
 * organização confirmada — e um anúncio que não acontece não invalida nada.
 */
function PaginaSonda({
  fetchWithAuth,
  identidade,
}: {
  fetchWithAuth: AuthenticatedFetch;
  identidade: string | null;
}) {
  const [selecaoAnunciada, setSelecaoAnunciada] = useState<SelecaoDeOrganizacao | null>(null);
  const lista = useOrganizationsList(fetchWithAuth, identidade);
  const selecao = identidade === null ? null : selecaoAnunciada;

  const { organizacaoId } = usePapelNaOrganizacaoAtiva(fetchWithAuth, identidade, selecao);

  return (
    <div>
      {identidade !== null && (
        <PainelDaAba fetchWithAuth={fetchWithAuth} lista={lista} onSelecao={setSelecaoAnunciada} />
      )}
      <span data-testid="selecao">{selecao?.id ?? '(nenhuma)'}</span>
      <span data-testid="confirmada">{organizacaoId ?? '(nenhuma)'}</span>
    </div>
  );
}

/** Fronteira de rede da página: responde conforme a sessão que o teste declarar. */
function fetchDaPagina(inicial: typeof ORG_A) {
  let organizacaoDaVez = inicial;
  const fn = vi.fn(async (url: string) => {
    if (url === '/api/organizacoes') return jsonResponse(corpoDe(organizacaoDaVez, 3));
    return jsonResponse({ convites: [], membros: [] });
  });
  return {
    fetchWithAuth: fn as unknown as AuthenticatedFetch,
    passarAResponder: (org: typeof ORG_A) => {
      organizacaoDaVez = org;
    },
  };
}

describe('a seleção usada pela autoridade sobre papel', () => {
  it('D) não permanece com a organização da sessão anterior após o logout', async () => {
    const { fetchWithAuth } = fetchDaPagina(ORG_A);
    const { rerender } = render(<PaginaSonda fetchWithAuth={fetchWithAuth} identidade={ANA} />);

    await waitFor(() => expect(screen.getByTestId('selecao')).toHaveTextContent(ORG_A.id));
    await waitFor(() => expect(screen.getByTestId('confirmada')).toHaveTextContent(ORG_A.id));

    rerender(<PaginaSonda fetchWithAuth={fetchWithAuth} identidade={null} />);

    expect(screen.getByTestId('selecao')).toHaveTextContent('(nenhuma)');
    expect(screen.getByTestId('confirmada')).toHaveTextContent('(nenhuma)');
  });

  it('D2) nem quando a identidade troca direto, sem passar por logout', async () => {
    const { fetchWithAuth, passarAResponder } = fetchDaPagina(ORG_A);
    const { rerender } = render(<PaginaSonda fetchWithAuth={fetchWithAuth} identidade={ANA} />);

    await waitFor(() => expect(screen.getByTestId('selecao')).toHaveTextContent(ORG_A.id));

    passarAResponder(ORG_B);
    rerender(<PaginaSonda fetchWithAuth={fetchWithAuth} identidade={BRUNO} />);

    // A seleção de Ana não pode continuar valendo nem por um instante.
    expect(screen.getByTestId('selecao')).not.toHaveTextContent(ORG_A.id);
    expect(screen.getByTestId('confirmada')).not.toHaveTextContent(ORG_A.id);

    await waitFor(() => expect(screen.getByTestId('selecao')).toHaveTextContent(ORG_B.id));
    await waitFor(() => expect(screen.getByTestId('confirmada')).toHaveTextContent(ORG_B.id));
  });
});
