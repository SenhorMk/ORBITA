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
 * O carimbo é usado em dois lugares. Guardado junto do estado, impede que a
 * leitura de uma sessão seja **exibida** em outra. Comparado com
 * `sessaoAtualRef` quando a resposta chega, impede que uma resposta atrasada
 * seja **gravada** por cima da leitura de quem entrou depois.
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
 * ## Duas abas trocando de organização ao mesmo tempo
 *
 * Problema: a pessoa abre duas abas; numa escolhe a organização A, na outra a
 * B. Sem cuidado, a última a chegar ao servidor venceria em silêncio, e uma das
 * abas continuaria mostrando uma organização que já não é a ativa.
 *
 * Solução: o servidor guarda a organização ativa junto com um número de versão.
 * A tela lê essa versão (`selectionVersion`) e a envia ao pedir a troca. O banco
 * só troca se a versão ainda for a mesma; se outra aba já trocou antes, a
 * versão mudou, a troca é recusada (409) e a tela mostra o erro em vez de
 * sobrescrever. Esse "só grava se ainda estiver como eu li" chama-se CAS
 * (compare-and-swap).
 *
 * ## Respostas atrasadas e troca de sessão
 *
 * Este hook vive no topo da aplicação e continua existindo depois do logout.
 * Por isso cada leitura é carimbada com a sessão que a pediu, e nada é exibido
 * se o carimbo não bater com a sessão atual. Na prática:
 * - depois do logout, nenhuma organização, versão ou erro da sessão anterior
 *   aparece;
 * - uma resposta da pessoa A que chega depois do login da pessoa B é
 *   descartada, e não apaga a leitura de B.
 *
 * A sessão também é devolvida pelo hook: o painel a usa para erros que são da
 * pessoa e não da organização, como o aceite de convite (feito, muitas vezes,
 * por quem ainda não tem organização nenhuma).
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

  /**
   * Cria a organização e relê a lista.
   *
   * Devolve se criou, para o formulário saber se pode fechar. A mensagem da
   * falha fica em `error`.
   */
  async function handleCreateOrganization(nome: string, slug: string): Promise<boolean> {
    if (sessao === null) return false;
    setErro(null);
    const response = await fetchWithAuth('/api/organizacoes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nome, slug }),
    });
    const body = await response.json();
    if (sessaoAtualRef.current !== sessao) return false;
    if (!response.ok) {
      setErro({ sessao, valor: body.error ?? 'Falha ao criar organização' });
      return false;
    }
    await lerNaSessao(sessao);
    return true;
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
    sessao,
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
