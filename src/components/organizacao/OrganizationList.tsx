'use client';

import { Button } from '@/components/ui/button';
import type { Organizacao } from './types';

export interface OrganizationListProps {
  organizacoes: readonly Organizacao[];
  activeOrgId: string | null;
  switchingOrgId: string | null;
  onSwitch: (orgId: string) => void;
}

/** Lista de organizações do usuário com ação para trocar a ativa (CAS no chamador). */
export function OrganizationList({ organizacoes, activeOrgId, switchingOrgId, onSwitch }: OrganizationListProps) {
  return (
    <div className="grid gap-2">
      {organizacoes.map((org) => {
        const isActive = activeOrgId === org.id;
        return (
          <div
            key={org.id}
            className="flex items-center justify-between rounded-xl border border-white/10 bg-white/5 px-3 py-2"
          >
            <span className="text-sm text-white">{org.nome}</span>
            {isActive ? (
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-[#30D158]/15 text-[#30D158] border border-[#30D158]/30 font-semibold">
                Ativa
              </span>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={switchingOrgId === org.id}
                onClick={() => onSwitch(org.id)}
              >
                {switchingOrgId === org.id ? 'Trocando…' : `Trocar para ${org.nome}`}
              </Button>
            )}
          </div>
        );
      })}
    </div>
  );
}
