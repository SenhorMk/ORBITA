'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';

export interface AcceptInviteFormProps {
  onAccept: (token: string) => Promise<void>;
}

/** Aceita um convite por token; o servidor valida expiração/organização (`acceptOrgInvite`). */
export function AcceptInviteForm({ onAccept }: AcceptInviteFormProps) {
  const [token, setToken] = useState('');
  const [accepting, setAccepting] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setAccepting(true);
    try {
      await onAccept(token);
      setToken('');
    } finally {
      setAccepting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-2 rounded-xl border border-white/10 bg-white/5 p-3">
      <h3 className="text-sm font-semibold text-white">Aceitar convite</h3>
      <label className="block text-xs text-slate-400" htmlFor="convite-token">
        Token do convite
      </label>
      <input
        id="convite-token"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        className="w-full rounded-lg bg-black/30 border border-white/10 px-2 py-1.5 text-sm text-white"
        required
        minLength={16}
      />
      <Button type="submit" size="sm" disabled={accepting}>
        {accepting ? 'Aceitando…' : 'Aceitar convite'}
      </Button>
    </form>
  );
}
