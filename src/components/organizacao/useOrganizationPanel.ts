import { useEffect, useMemo } from 'react';
import type { SelecaoDeOrganizacao } from './usePapelNaOrganizacaoAtiva';
import { useOrganizationsList } from './useOrganizationsList';
import { useOrganizationInvites } from './useOrganizationInvites';
import { useOrganizationMembers } from './useOrganizationMembers';

export type AuthenticatedFetch = (url: string, options?: RequestInit) => Promise<Response>;

/**
 * Composição de estado do painel de organização (Ticket 24b): organizações
 * (`useOrganizationsList`), convites (`useOrganizationInvites`) e membros
 * (`useOrganizationMembers`) — cada um pequeno e focado numa única fronteira
 * de API. Nenhuma decisão de autorização é tomada aqui; cada hook apenas
 * chama a rota já verificada no servidor e reflete o resultado.
 */
export function useOrganizationPanel(
  fetchWithAuth: AuthenticatedFetch,
  onActiveOrgChange?: (selecao: SelecaoDeOrganizacao | null) => void,
) {
  const list = useOrganizationsList(fetchWithAuth);
  const orgId = list.activeOrg?.organizacao.id ?? null;
  const invites = useOrganizationInvites(fetchWithAuth, orgId, () => { void list.loadOrganizacoes(); });
  const members = useOrganizationMembers(fetchWithAuth, orgId);

  // A seleção sai daqui com **id e versão**. Só o id não distingue trocar de
  // organização e voltar para a mesma, e quem depende disso é a autoridade
  // visual: sem a versão, um papel antigo continuaria valendo (revisão do #66).
  const selecao = useMemo(
    () => (orgId === null ? null : { id: orgId, versao: list.selectionVersion }),
    [orgId, list.selectionVersion],
  );

  useEffect(() => {
    onActiveOrgChange?.(selecao);
  }, [selecao, onActiveOrgChange]);

  const canManage = list.activeOrg?.papel === 'owner' || list.activeOrg?.papel === 'admin';
  const error = list.error ?? invites.error ?? members.error;

  return {
    organizacoes: list.organizacoes,
    activeOrg: list.activeOrg,
    selecao,
    isLoading: list.isLoading,
    switchingOrgId: list.switchingOrgId,
    loadOrganizacoes: list.loadOrganizacoes,
    handleCreateOrganization: list.handleCreateOrganization,
    handleSwitchOrganization: list.handleSwitchOrganization,
    convites: invites.convites,
    handleInvite: invites.handleInvite,
    handleAcceptInvite: invites.handleAcceptInvite,
    membros: members.membros,
    handleRemoveMember: members.handleRemoveMember,
    canManage,
    error,
  };
}
