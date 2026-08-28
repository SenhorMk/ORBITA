import { useCallback, useEffect, useState } from 'react';
import type { MembroOrganizacao } from './types';
import type { AuthenticatedFetch } from './useOrganizationPanel';

/** Lista e remove membros de uma organização (`/api/organizacoes/[id]/membros`). */
export function useOrganizationMembers(fetchWithAuth: AuthenticatedFetch, orgId: string | null) {
  const [membros, setMembros] = useState<MembroOrganizacao[]>([]);
  const [error, setError] = useState<string | null>(null);

  const loadMembros = useCallback(
    async (targetOrgId: string) => {
      try {
        const response = await fetchWithAuth(`/api/organizacoes/${targetOrgId}/membros`);
        const body = await response.json();
        if (response.ok) setMembros(body.membros ?? []);
      } catch {
        // Falha silenciosa: lista de membros é informativa, não bloqueia o restante da tela.
      }
    },
    [fetchWithAuth],
  );

  useEffect(() => {
    if (!orgId) return;
    let isMounted = true;
    void (async () => {
      if (isMounted) await loadMembros(orgId);
    })();
    return () => {
      isMounted = false;
    };
  }, [orgId, loadMembros]);

  async function handleRemoveMember(userId: string) {
    if (!orgId) return;
    setError(null);
    const response = await fetchWithAuth(`/api/organizacoes/${orgId}/membros/${userId}`, { method: 'DELETE' });
    const body = await response.json();
    if (!response.ok) {
      setError(body.error ?? 'Falha ao remover membro');
      return;
    }
    await loadMembros(orgId);
  }

  return { membros, error, handleRemoveMember };
}
