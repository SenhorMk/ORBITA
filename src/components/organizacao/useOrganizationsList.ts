import { useCallback, useEffect, useRef, useState } from 'react';
import type { ActiveOrg, Organizacao } from './types';
import type { AuthenticatedFetch } from './useOrganizationPanel';

/** Nenhuma organização — identidade estável, para não recriar array a cada render. */
const NENHUMA: Organizacao[] = [];

/** O que uma leitura trouxe, **e de qual sessão**. */
interface LeituraDeOrganizacoes {
  readonly sessao: string;
  readonly organizacoes: Organizacao[];
  readonly activeOrg: ActiveOrg | null;
  readonly selectionVersion: number;
}

/** Um estado transitório (erro, troca em curso) e a sessão a que pertence. */
interface TransitorioDaSessao {
  readonly sessao: string;
  readonly valor: string;
}

/** O valor de um transitório, ou `null` se ele for de outra sessão. */
function daSessao(sessao: string | null, t: TransitorioDaSessao | null): string | null {
  return sessao !== null && t !== null && t.sessao === sessao ? t.valor : null;
}

/**
 * A leitura de `/api/organizacoes`, carimbada pela sessão que a pediu.
 *
 * O carimbo é o mecanismo inteiro. Ele aparece duas vezes, e é preciso as duas:
 * gravado no estado, impede que a leitura de uma sessão seja **exibida** em
 * outra; comparado com `sessaoAtualRef` dentro da resposta, impede que uma
 * resposta atrasada seja **gravada** — inclusive por cima da leitura boa de
 * quem entrou depois, que sumiria da tela sem nunca ter sido substituída por
 * nada visível.
 */
function useLeituraDeOrganizacoes(fetchWithAuth: AuthenticatedFetch, sessao: string | null) {
  const [leitura, setLeitura] = useState<LeituraDeOrganizacoes | null>(null);
  const [erro, setErro] = useState<TransitorioDaSessao | null>(null);
  const sessaoAtualRef = useRef(sessao);

  const lerNaSessao = useCallback(
    async (daLeitura: string) => {
      try {
        const response = await fetchWithAuth('/api/organizacoes');
        const body = await response.json();
        if (sessaoAtualRef.current !== daLeitura) return;
        if (!response.ok) {
          setErro({ sessao: daLeitura, valor: body.error ?? 'Falha ao carregar organizações' });
          return;
        }
        setErro(null);
        setLeitura({
          sessao: daLeitura,
          organizacoes: body.organizacoes ?? [],
          activeOrg: body.activeOrg ?? null,
          selectionVersion: body.selectionVersion ?? 0,
        });
      } catch {
        if (sessaoAtualRef.current !== daLeitura) return;
        setErro({ sessao: daLeitura, valor: 'Falha ao carregar organizações' });
      }
    },
    [fetchWithAuth],
  );

  useEffect(() => {
    sessaoAtualRef.current = sessao;
    if (sessao === null) return;
    // A leitura é disparada e esquecida: tudo que ela grava acontece depois da
    // resposta do servidor, nunca durante o efeito.
    void (async () => {
      await lerNaSessao(sessao);
    })();
  }, [lerNaSessao, sessao]);

  return { leitura, setLeitura, erro, setErro, sessaoAtualRef, lerNaSessao };
}

/**
 * Carrega, cria e troca organizações (`/api/organizacoes`,
 * `/api/organizacoes/switch`).
 *
 * `selectionVersion` sai daqui porque a tela precisa dela: trocar de
 * organização e voltar para a mesma são seleções diferentes, e é a versão que
 * separa uma da outra.
 *
 * ## Tudo que este hook guarda carrega de quem é
 *
 * Enquanto ele vivia dentro do painel de organização, o desmonte do painel
 * levava o estado junto e não havia o que decidir. Desde o Ticket 01 ele vive
 * no topo da aplicação e **atravessa o logout** — e num shell multi-tenant um
 * tenant que sobrevive à sessão que o produziu é o defeito que não se pode ter.
 *
 * A solução não é limpar o estado quando a sessão cai; é o estado não valer
 * fora dela. Nada é exposto sem o carimbo da leitura bater com a sessão
 * corrente. Disso decorre, sem nenhum passo extra:
 *
 * - perder a sessão não deixa organização, organização ativa, versão, erro ou
 *   troca em curso visíveis — nem enquanto a leitura seguinte não chega, nem se
 *   ela falhar;
 * - a resposta de uma requisição do usuário A que só volta depois do login de B
 *   não é gravada nem exibida, e não apaga a leitura boa de B;
 * - a sessão nova começa sem tenant herdado, e só a resposta dela passa a valer.
 *
 * É o mesmo desenho de `usePapelNaOrganizacaoAtiva`, pela mesma razão: um dado
 * de sessão que não diz de quem é não tem como ser invalidado na hora certa.
 *
 * @param sessao - Quem está logado (o e-mail serve), ou `null` sem sessão. Sem
 *   sessão não se pergunta nada ao servidor — `fetchWithAuth` lança sem token —
 *   e não se mostra nada.
 */
export function useOrganizationsList(fetchWithAuth: AuthenticatedFetch, sessao: string | null) {
  const { leitura, setLeitura, erro, setErro, sessaoAtualRef, lerNaSessao } = useLeituraDeOrganizacoes(
    fetchWithAuth,
    sessao,
  );
  const [trocando, setTrocando] = useState<TransitorioDaSessao | null>(null);

  const valeAgora = sessao !== null && leitura !== null && leitura.sessao === sessao;
  const error = daSessao(sessao, erro);
  // A versão que a troca compara é a da sessão corrente, nunca a de uma leitura
  // que ficou para trás: o CAS do servidor recusaria, e com razão.
  const selectionVersion = valeAgora ? leitura.selectionVersion : 0;

  const loadOrganizacoes = useCallback(async () => {
    if (sessao !== null) await lerNaSessao(sessao);
  }, [lerNaSessao, sessao]);

  async function handleCreateOrganization(nome: string, slug: string) {
    if (sessao === null) return;
    setErro(null);
    const response = await fetchWithAuth('/api/organizacoes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nome, slug }),
    });
    const body = await response.json();
    if (sessaoAtualRef.current !== sessao) return;
    if (!response.ok) {
      setErro({ sessao, valor: body.error ?? 'Falha ao criar organização' });
      return;
    }
    await lerNaSessao(sessao);
  }

  async function handleSwitchOrganization(orgId: string) {
    if (sessao === null) return;
    setTrocando({ sessao, valor: orgId });
    setErro(null);
    try {
      const response = await fetchWithAuth('/api/organizacoes/switch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ organizacao_id: orgId, expected_version: selectionVersion }),
      });
      const body = await response.json();
      if (sessaoAtualRef.current !== sessao) return;
      if (!response.ok) {
        setErro({ sessao, valor: body.error ?? 'Falha ao trocar de organização' });
        return;
      }
      setLeitura((anterior) => ({
        sessao,
        // A troca responde com a organização ativa e a versão novas; a lista de
        // organizações é a mesma e não vem no corpo.
        organizacoes: anterior?.sessao === sessao ? anterior.organizacoes : [],
        activeOrg: body.activeOrg ?? null,
        selectionVersion: body.selectionVersion ?? selectionVersion,
      }));
    } finally {
      if (sessaoAtualRef.current === sessao) setTrocando(null);
    }
  }

  return {
    organizacoes: valeAgora ? leitura.organizacoes : NENHUMA,
    activeOrg: valeAgora ? leitura.activeOrg : null,
    selectionVersion,
    // Há sessão, ainda não há leitura dela, e nada falhou: é isso que carregar
    // significa. Depois de um logout o valor volta sozinho para "carregando" na
    // sessão seguinte, sem ninguém precisar reatribuí-lo.
    isLoading: sessao !== null && !valeAgora && error === null,
    error,
    switchingOrgId: daSessao(sessao, trocando),
    loadOrganizacoes,
    handleCreateOrganization,
    handleSwitchOrganization,
  };
}
