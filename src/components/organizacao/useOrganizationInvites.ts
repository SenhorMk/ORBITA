import { useCallback, useState } from 'react';
import type { Convite, ConviteCriado } from './types';
import type { AuthenticatedFetch } from './useOrganizationPanel';
import { useLeituraPorOrganizacao } from './useLeituraPorOrganizacao';
import type { SelecaoDeOrganizacao } from './usePapelNaOrganizacaoAtiva';

/** A frase que a tela mostra quando a leitura de convites falha sem detalhe útil. */
const FALHA_AO_LER = 'Não foi possível carregar os convites';

/**
 * Cria, lista e aceita convites de organização
 * (`/api/organizacoes/[id]/convites`, `/api/convites/aceitar`).
 *
 * ## Ticket 06 — o mesmo carimbo dos membros, e o código do convite
 *
 * A lista de convites tinha os dois defeitos de `useOrganizationMembers`, pela
 * mesma razão e com a mesma consequência: estado sem dono, então convites de A
 * apareciam sob B; e falha engolida, então uma leitura que não deu certo dizia
 * "nenhum convite" — e um convite pendente que desaparece da lista é um
 * convite que ninguém revoga e ninguém acompanha. A correção é a mesma:
 * `useLeituraPorOrganizacao` e uma leitura que lança.
 *
 * **O convite é nominal e a entrega é manual, então o código tem de voltar
 * para a tela.** `POST .../convites` sempre devolveu `{ id, token }`, e este
 * hook descartava a resposta inteira para só recarregar a lista. Sem o token
 * não existe jornada: o servidor cria o convite, e a pessoa que o criou não
 * tem o que enviar por WhatsApp. `handleInvite` agora devolve o convite criado
 * — e ele fica onde nasceu, no estado de React de quem pediu: nunca em
 * `localStorage`, nunca em log.
 *
 * @param selecao - A organização ativa confirmada e a versão que a selecionou.
 * @param onAccepted - Chamado depois de um aceite bem-sucedido, para que o
 *   contexto canônico e a lista de organizações sejam relidos do servidor.
 */
export function useOrganizationInvites(
  fetchWithAuth: AuthenticatedFetch,
  selecao: SelecaoDeOrganizacao | null,
  onAccepted: () => void,
) {
  const [erroDeAcao, setErroDeAcao] = useState<string | null>(null);
  const [erroDeAceite, setErroDeAceite] = useState<string | null>(null);

  const ler = useCallback(
    async (organizacaoId: string): Promise<readonly Convite[]> => {
      const response = await fetchWithAuth(`/api/organizacoes/${organizacaoId}/convites`);
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error ?? FALHA_AO_LER);
      return body?.convites ?? [];
    },
    [fetchWithAuth],
  );

  const { dados, carregando, erro, recarregar } = useLeituraPorOrganizacao(selecao, ler, FALHA_AO_LER);

  /**
   * Cria o convite e devolve o código para a tela mostrar.
   *
   * @returns O convite criado, ou `null` se a criação falhou — aí a falha está
   *   em `erroDeAcao`.
   */
  const handleInvite = useCallback(
    async (email: string, papel: 'admin' | 'member'): Promise<ConviteCriado | null> => {
      if (selecao === null) return null;
      setErroDeAcao(null);
      const response = await fetchWithAuth(`/api/organizacoes/${selecao.id}/convites`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, papel }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        setErroDeAcao(body?.error ?? 'Falha ao criar convite');
        return null;
      }
      await recarregar();
      const criado = body?.convite;
      if (typeof criado?.token !== 'string' || typeof criado?.id !== 'string') {
        // O convite existe no servidor, mas sem o código não há o que entregar.
        // Dizer "criado com sucesso" mandaria a pessoa procurar um código que a
        // tela não tem.
        setErroDeAcao('O convite foi criado, mas o código não voltou. Recarregue e verifique a lista.');
        return null;
      }
      return { id: criado.id, token: criado.token, email, papel };
    },
    [fetchWithAuth, recarregar, selecao],
  );

  const handleAcceptInvite = useCallback(
    async (token: string): Promise<boolean> => {
      setErroDeAceite(null);
      const response = await fetchWithAuth('/api/convites/aceitar', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        setErroDeAceite(body?.error ?? 'Falha ao aceitar convite');
        return false;
      }
      onAccepted();
      return true;
    },
    [fetchWithAuth, onAccepted],
  );

  return {
    convites: dados,
    carregando,
    erroDeLeitura: erro,
    erroDeAcao,
    erroDeAceite,
    recarregar,
    handleInvite,
    handleAcceptInvite,
  };
}
