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
 * A lista **entra por parâmetro** desde o Ticket 01. Antes ela era criada aqui
 * dentro, e o shell passou a precisar da mesma informação para mostrar e trocar
 * a organização ativa. Duas instâncias do mesmo estado divergiriam na primeira
 * troca feita pelo topo: o painel continuaria anunciando a organização
 * anterior. Uma organização ativa só pode ter uma fonte.
 *
 * ## Ticket 06 — a seleção desce inteira, e os erros não se misturam
 *
 * **A seleção desce inteira.** Antes só o `orgId` era repassado aos dois hooks
 * de leitura, e a versão ficava aqui, usada apenas para avisar o shell. Com o
 * id sozinho, A → B → A não é distinguível de continuar em A: a resposta
 * atrasada da primeira visita chega durante a segunda e é aceita. Agora
 * `selecao` — o par (organização, versão) — é o que os hooks recebem, e é por
 * ele que eles carimbam o que leem.
 *
 * **Os erros não se misturam.** `error = list.error ?? invites.error ??
 * members.error` colapsava três leituras independentes num campo só: a falha
 * de convites aparecia como se fosse da tela inteira, e a de membros
 * desaparecia atrás dela. Cada leitura agora carrega o seu próprio estado, e a
 * tela mostra cada falha junto da lista a que ela pertence.
 *
 * **A sessão desce junto da seleção** (revisão externa da PR #84). Quase tudo
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
