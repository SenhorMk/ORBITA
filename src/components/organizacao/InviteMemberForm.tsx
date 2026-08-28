'use client';

import { useState } from 'react';
import { UserPlus, Ticket } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { Convite } from './types';

export interface InviteMemberFormProps {
  convites: readonly Convite[];
  onInvite: (email: string, papel: 'admin' | 'member') => Promise<void>;
}

/** Formulário de convite de membro; o servidor decide se há capacidade/plano para aceitar o convite. */
export function InviteMemberForm({ convites, onInvite }: InviteMemberFormProps) {
  const [email, setEmail] = useState('');
  const [papel, setPapel] = useState<'admin' | 'member'>('member');
  const [inviting, setInviting] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setInviting(true);
    try {
      await onInvite(email, papel);
      setEmail('');
    } finally {
      setInviting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-2 rounded-xl border border-white/10 bg-white/5 p-3">
      <h3 className="text-sm font-semibold text-white flex items-center gap-1.5">
        <UserPlus className="w-4 h-4" /> Convidar membro
      </h3>
      <label className="block text-xs text-slate-400" htmlFor="convite-email">
        E-mail do convidado
      </label>
      <input
        id="convite-email"
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className="w-full rounded-lg bg-black/30 border border-white/10 px-2 py-1.5 text-sm text-white"
        required
      />
      <select
        aria-label="Papel do convidado"
        value={papel}
        onChange={(e) => setPapel(e.target.value as 'admin' | 'member')}
        className="w-full rounded-lg bg-black/30 border border-white/10 px-2 py-1.5 text-sm text-white"
      >
        <option value="member">Membro</option>
        <option value="admin">Administrador</option>
      </select>
      <Button type="submit" size="sm" disabled={inviting}>
        {inviting ? 'Enviando…' : 'Enviar convite'}
      </Button>

      {convites.length > 0 && (
        <ul className="mt-2 space-y-1 text-xs text-slate-300">
          {convites.map((convite) => (
            <li key={convite.id} className="flex items-center gap-2">
              <Ticket className="w-3 h-3 text-slate-500" />
              {convite.email} — {convite.status}
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}
