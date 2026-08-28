'use client';

import { Building2 } from 'lucide-react';
import { OrganizationList } from './OrganizationList';
import { CreateOrganizationForm } from './CreateOrganizationForm';
import { InviteMemberForm } from './InviteMemberForm';
import { AcceptInviteForm } from './AcceptInviteForm';
import { MembersList } from './MembersList';
import { useOrganizationPanel, type AuthenticatedFetch } from './useOrganizationPanel';

export interface OrganizationPanelProps {
  /** Authenticated fetch boundary (Supabase bearer token attached by the caller). */
  fetchWithAuth: AuthenticatedFetch;
  /** Notified whenever the server-confirmed active organization changes, so sibling panels (billing, integrations) can scope their own requests. */
  onActiveOrgChange?: (organizacaoId: string | null) => void;
}

/**
 * Organização/membros essenciais do MVP (Ticket 24b): criar organização,
 * listar/trocar organização (CAS), convidar e aceitar convite, listar e
 * remover membro. A UI nunca decide autorização: cada ação chama a rota já
 * verificada no servidor e apenas reflete o resultado. Estado e chamadas de
 * API vivem em `useOrganizationPanel`; este componente só compõe a
 * apresentação a partir dele.
 */
export function OrganizationPanel({ fetchWithAuth, onActiveOrgChange }: OrganizationPanelProps) {
  const panel = useOrganizationPanel(fetchWithAuth, onActiveOrgChange);

  return (
    <div className="space-y-6 text-slate-200">
      <div className="flex items-center gap-2">
        <Building2 className="w-5 h-5 text-[#0A84FF]" />
        <h2 className="text-lg font-semibold text-white">Organização</h2>
      </div>

      {panel.error && (
        <div role="alert" className="text-sm text-red-300 bg-red-500/10 border border-red-500/30 rounded-xl px-3 py-2">
          {panel.error}
        </div>
      )}

      {panel.isLoading ? (
        <div className="text-sm text-slate-400">Carregando organizações…</div>
      ) : (
        <>
          {panel.activeOrg && (
            <div className="text-sm text-slate-300">
              Organização ativa: <span className="font-semibold text-white">{panel.activeOrg.organizacao.nome}</span>{' '}
              <span className="text-xs text-slate-400">({panel.activeOrg.papel})</span>
            </div>
          )}

          <OrganizationList
            organizacoes={panel.organizacoes}
            activeOrgId={panel.activeOrg?.organizacao.id ?? null}
            switchingOrgId={panel.switchingOrgId}
            onSwitch={panel.handleSwitchOrganization}
          />

          <CreateOrganizationForm onCreate={panel.handleCreateOrganization} />

          {panel.canManage && <InviteMemberForm convites={panel.convites} onInvite={panel.handleInvite} />}

          <AcceptInviteForm onAccept={panel.handleAcceptInvite} />

          <MembersList membros={panel.membros} canManage={panel.canManage} onRemove={panel.handleRemoveMember} />

          <button
            type="button"
            onClick={() => panel.loadOrganizacoes()}
            className="text-xs text-slate-400 hover:text-white"
          >
            Atualizar
          </button>
        </>
      )}
    </div>
  );
}
