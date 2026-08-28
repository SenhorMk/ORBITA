'use client';

import { Users, Trash2 } from 'lucide-react';
import type { MembroOrganizacao } from './types';

export interface MembersListProps {
  membros: readonly MembroOrganizacao[];
  canManage: boolean;
  onRemove: (userId: string) => Promise<void>;
}

/** Lista de membros ativos e ação de remoção; o owner nunca aparece removível (o servidor também recusaria). */
export function MembersList({ membros, canManage, onRemove }: MembersListProps) {
  return (
    <div className="space-y-2 rounded-xl border border-white/10 bg-white/5 p-3" data-testid="members-list">
      <h3 className="text-sm font-semibold text-white flex items-center gap-1.5">
        <Users className="w-4 h-4" /> Membros
      </h3>
      {membros.length === 0 ? (
        <p className="text-xs text-slate-400">Nenhum membro encontrado.</p>
      ) : (
        <ul className="space-y-1">
          {membros.map((membro) => (
            <li key={membro.user_id} className="flex items-center justify-between text-xs text-slate-300">
              <span>
                {membro.user_id} <span className="text-slate-500">({membro.papel})</span>
              </span>
              {canManage && membro.papel !== 'owner' && (
                <button
                  type="button"
                  aria-label={`Remover ${membro.user_id}`}
                  onClick={() => onRemove(membro.user_id)}
                  className="text-red-300 hover:text-red-200"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span className="sr-only">Remover</span>
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
