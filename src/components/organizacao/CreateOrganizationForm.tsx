'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';

export interface CreateOrganizationFormProps {
  onCreate: (nome: string, slug: string) => Promise<void>;
}

/** Formulário de criação de organização; a validação de negócio vive no servidor (`createOrgInputSchema`). */
export function CreateOrganizationForm({ onCreate }: CreateOrganizationFormProps) {
  const [nome, setNome] = useState('');
  const [slug, setSlug] = useState('');
  const [creating, setCreating] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setCreating(true);
    try {
      await onCreate(nome, slug);
      setNome('');
      setSlug('');
    } finally {
      setCreating(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-2 rounded-xl border border-white/10 bg-white/5 p-3">
      <h3 className="text-sm font-semibold text-white">Criar nova organização</h3>
      <label className="block text-xs text-slate-400" htmlFor="org-nome">
        Nome da organização
      </label>
      <input
        id="org-nome"
        value={nome}
        onChange={(e) => setNome(e.target.value)}
        className="w-full rounded-lg bg-black/30 border border-white/10 px-2 py-1.5 text-sm text-white"
        required
      />
      <label className="block text-xs text-slate-400" htmlFor="org-slug">
        Slug
      </label>
      <input
        id="org-slug"
        value={slug}
        onChange={(e) => setSlug(e.target.value)}
        className="w-full rounded-lg bg-black/30 border border-white/10 px-2 py-1.5 text-sm text-white"
        required
      />
      <Button type="submit" size="sm" disabled={creating}>
        {creating ? 'Criando…' : 'Criar organização'}
      </Button>
    </form>
  );
}
