import { useCallback, useState } from 'react';
import type { MembroOrganizacao } from './types';
import type { AuthenticatedFetch } from './useOrganizationPanel';
import { useLeituraPorOrganizacao } from './useLeituraPorOrganizacao';
import type { SelecaoDeOrganizacao } from './usePapelNaOrganizacaoAtiva';

/** A frase que a tela mostra quando a leitura de membros falha sem detalhe útil. */
const FALHA_AO_LER = 'Não foi possível carregar os membros';

/**
 * Lista e remove membros de uma organização (`/api/organizacoes/[id]/membros`).
 *
 * ## Ticket 06 — duas correções, e as duas são sobre dizer a verdade
 *
 * **A lista pertencia a ninguém.** O estado era um `MembroOrganizacao[]` solto,
 * chaveado por nada: trocar de A para B mantinha os membros de A na tela até a
 * resposta de B chegar, e uma resposta atrasada de A que chegasse *depois* da
 * de B sobrescrevia B com A. Num shell multi-tenant é o defeito que não se pode
 * ter — os nomes de uma organização sob o contexto visual de outra. Agora a
 * leitura é carimbada pela seleção (organização **e** versão) em
 * `useLeituraPorOrganizacao`, e o carimbo resolve as duas direções de uma vez.
 *
 * **A falha virava "nenhum membro".** O `catch {}` engolia a exceção e o
 * `if (response.ok)` descartava o erro sem registrá-lo — em ambos os casos a
 * tela ficava com a lista anterior ou com a vazia, dizendo que a organização
 * não tem membros quando o que houve foi uma leitura que não deu certo. Numa
 * tela de autoridade isso é pior que um erro: sugere que uma revogação já
 * aconteceu. Agora a leitura lança, e a tela distingue carregando, vazio
 * verdadeiro e falha.
 *
 * @param selecao - A organização ativa confirmada e a versão que a selecionou,
 *   ou `null` sem seleção (inclusive sem sessão).
 */
export function useOrganizationMembers(
  fetchWithAuth: AuthenticatedFetch,
  selecao: SelecaoDeOrganizacao | null,
) {
  const [erroDeAcao, setErroDeAcao] = useState<string | null>(null);

  const ler = useCallback(
    async (organizacaoId: string): Promise<readonly MembroOrganizacao[]> => {
      const response = await fetchWithAuth(`/api/organizacoes/${organizacaoId}/membros`);
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error ?? FALHA_AO_LER);
      return body?.membros ?? [];
    },
    [fetchWithAuth],
  );

  const { dados, carregando, erro, recarregar } = useLeituraPorOrganizacao(selecao, ler, FALHA_AO_LER);

  const handleRemoveMember = useCallback(
    async (userId: string) => {
      if (selecao === null) return;
      setErroDeAcao(null);
      const response = await fetchWithAuth(`/api/organizacoes/${selecao.id}/membros/${userId}`, {
        method: 'DELETE',
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        setErroDeAcao(body?.error ?? 'Falha ao remover membro');
        return;
      }
      await recarregar();
    },
    [fetchWithAuth, recarregar, selecao],
  );

  return {
    membros: dados,
    carregando,
    erroDeLeitura: erro,
    // A falha de uma remoção é outra coisa que a falha de ler a lista, e a tela
    // as mostra em lugares diferentes: uma lista que carregou bem continua
    // válida quando um botão dela falha.
    erroDeAcao,
    recarregar,
    handleRemoveMember,
  };
}
