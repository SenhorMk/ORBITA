import { useCallback, useEffect, useMemo } from 'react';
import type { SelecaoDeOrganizacao } from './usePapelNaOrganizacaoAtiva';
import type { useOrganizationsList } from './useOrganizationsList';
import { useOrganizationInvites } from './useOrganizationInvites';
import { useOrganizationMembers } from './useOrganizationMembers';

export type AuthenticatedFetch = (url: string, options?: RequestInit) => Promise<Response>;

/** O estado de organizações, como `useOrganizationsList` o devolve. */
export type ListaDeOrganizacoes = ReturnType<typeof useOrganizationsList>;

/**
 * Composição de estado do painel de organização: organizações
 * (`useOrganizationsList`), convites (`useOrganizationInvites`) e membros
 * (`useOrganizationMembers`) — cada um pequeno e focado numa única fronteira
 * de API. Nenhuma decisão de autorização é tomada aqui; cada hook apenas
 * chama a rota já verificada no servidor e reflete o resultado.
 *
 * A lista **entra por parâmetro**: o shell também precisa dela para mostrar e
 * trocar a organização ativa, e duas instâncias do mesmo estado divergiriam na
 * primeira troca feita pelo topo. Uma organização ativa só pode ter uma fonte.
 *
 * ## A seleção desce inteira, e os erros não se misturam
 *
 * **A seleção desce inteira.** Os hooks de leitura recebem `selecao` — o par
 * (organização, versão) —, e não só o id: com o id sozinho, A → B → A não é
 * distinguível de continuar em A, e a resposta atrasada da primeira visita
 * seria aceita durante a segunda. É pelo par que eles carimbam o que leem.
 *
 * **Os erros não se misturam.** Convites, membros e organizações são leituras
 * independentes: cada uma carrega o próprio estado de erro, e a tela mostra
 * cada falha junto da lista a que ela pertence, em vez de um erro único que
 * esconderia os outros.
 *
 * **A sessão desce junto da seleção.** Quase tudo
 * nesta tela é escopado por organização, mas o aceite de convite não é: quem
 * aceita pode não ter organização nenhuma, e é o caso principal. O erro dele
 * pertence à identidade, e é por ela que é carimbado.
 */
export function useOrganizationPanel(
  fetchWithAuth: AuthenticatedFetch,
  list: ListaDeOrganizacoes,
  onActiveOrgChange?: (selecao: SelecaoDeOrganizacao | null) => void,
) {
  const orgId = list.activeOrg?.organizacao.id ?? null;

  // A seleção sai daqui com **id e versão**. Só o id não distingue trocar de
  // organização e voltar para a mesma, e quem depende disso é toda leitura
  // escopada: a autoridade visual do papel (revisão do #66), os membros e os
  // convites.
  const selecao = useMemo(
    () => (orgId === null ? null : { id: orgId, versao: list.selectionVersion }),
    [orgId, list.selectionVersion],
  );

  const { loadOrganizacoes } = list;
  // Depois de um aceite, o contexto canônico é o do servidor: a lista é relida
  // dele. Nenhuma seleção local é inventada aqui.
  const aoAceitar = useCallback(() => { void loadOrganizacoes(); }, [loadOrganizacoes]);

  const invites = useOrganizationInvites(fetchWithAuth, selecao, list.sessao, aoAceitar);
  const members = useOrganizationMembers(fetchWithAuth, selecao);

  useEffect(() => {
    onActiveOrgChange?.(selecao);
  }, [selecao, onActiveOrgChange]);

  const canManage = list.activeOrg?.papel === 'owner' || list.activeOrg?.papel === 'admin';

  return {
    organizacoes: list.organizacoes,
    activeOrg: list.activeOrg,
    selecao,
    isLoading: list.isLoading,
    switchingOrgId: list.switchingOrgId,
    erroDeOrganizacoes: list.error,
    loadOrganizacoes: list.loadOrganizacoes,
    handleCreateOrganization: list.handleCreateOrganization,
    handleSwitchOrganization: list.handleSwitchOrganization,
    convites: invites.convites,
    convitesCarregando: invites.carregando,
    erroDeConvites: invites.erroDeLeitura,
    erroAoCriarConvite: invites.erroDeAcao,
    erroAoAceitarConvite: invites.erroDeAceite,
    criacaoDeConviteEmVoo: invites.criacaoEmVoo,
    recarregarConvites: invites.recarregar,
    handleInvite: invites.handleInvite,
    handleAcceptInvite: invites.handleAcceptInvite,
    membros: members.membros,
    membrosCarregando: members.carregando,
    erroDeMembros: members.erroDeLeitura,
    erroAoRemoverMembro: members.erroDeAcao,
    recarregarMembros: members.recarregar,
    handleRemoveMember: members.handleRemoveMember,
    canManage,
  };
}
