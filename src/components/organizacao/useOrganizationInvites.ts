import { useCallback, useEffect, useState } from 'react';
import type { Convite } from './types';
import type { AuthenticatedFetch } from './useOrganizationPanel';

/** Convida, lista e aceita convites de organização (`/api/organizacoes/[id]/convites`, `/api/convites/aceitar`). */
export function useOrganizationInvites(fetchWithAuth: AuthenticatedFetch, orgId: string | null, onAccepted: () => void) {
  const [convites, setConvites] = useState<Convite[]>([]);
  const [error, setError] = useState<string | null>(null);

  const loadConvites = useCallback(
    async (targetOrgId: string) => {
      try {
        const response = await fetchWithAuth(`/api/organizacoes/${targetOrgId}/convites`);
        const body = await response.json();
        if (response.ok) setConvites(body.convites ?? []);
      } catch {
        // Falha silenciosa: lista de convites é informativa, não bloqueia o restante da tela.
      }
    },
    [fetchWithAuth],
  );

  useEffect(() => {
    if (!orgId) return;
    let isMounted = true;
    void (async () => {
      if (isMounted) await loadConvites(orgId);
    })();
    return () => {
      isMounted = false;
    };
  }, [orgId, loadConvites]);

  async function handleInvite(email: string, papel: 'admin' | 'member') {
    if (!orgId) return;
    setError(null);
    const response = await fetchWithAuth(`/api/organizacoes/${orgId}/convites`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, papel }),
    });
    const body = await response.json();
    if (!response.ok) {
      setError(body.error ?? 'Falha ao convidar membro');
      return;
    }
    await loadConvites(orgId);
  }

  async function handleAcceptInvite(token: string) {
    setError(null);
    const response = await fetchWithAuth('/api/convites/aceitar', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    const body = await response.json();
    if (!response.ok) {
      setError(body.error ?? 'Falha ao aceitar convite');
      return;
    }
    onAccepted();
  }

  return { convites, error, handleInvite, handleAcceptInvite };
}
