import { useCallback, useEffect, useState } from 'react';
import type { ActiveOrg, Organizacao } from './types';
import type { AuthenticatedFetch } from './useOrganizationPanel';

/** Carrega, cria e troca organizações (`/api/organizacoes`, `/api/organizacoes/switch`). */
export function useOrganizationsList(fetchWithAuth: AuthenticatedFetch) {
  const [organizacoes, setOrganizacoes] = useState<Organizacao[]>([]);
  const [activeOrg, setActiveOrg] = useState<ActiveOrg | null>(null);
  const [selectionVersion, setSelectionVersion] = useState<number>(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [switchingOrgId, setSwitchingOrgId] = useState<string | null>(null);

  const loadOrganizacoes = useCallback(async () => {
    setError(null);
    try {
      const response = await fetchWithAuth('/api/organizacoes');
      const body = await response.json();
      if (!response.ok) {
        setError(body.error ?? 'Falha ao carregar organizações');
        return;
      }
      setOrganizacoes(body.organizacoes ?? []);
      setActiveOrg(body.activeOrg ?? null);
      setSelectionVersion(body.selectionVersion ?? 0);
    } catch {
      setError('Falha ao carregar organizações');
    }
  }, [fetchWithAuth]);

  useEffect(() => {
    let isMounted = true;
    void (async () => {
      setIsLoading(true);
      await loadOrganizacoes();
      if (isMounted) setIsLoading(false);
    })();
    return () => {
      isMounted = false;
    };
  }, [loadOrganizacoes]);

  async function handleCreateOrganization(nome: string, slug: string) {
    setError(null);
    const response = await fetchWithAuth('/api/organizacoes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nome, slug }),
    });
    const body = await response.json();
    if (!response.ok) {
      setError(body.error ?? 'Falha ao criar organização');
      return;
    }
    await loadOrganizacoes();
  }

  async function handleSwitchOrganization(orgId: string) {
    setSwitchingOrgId(orgId);
    setError(null);
    try {
      const response = await fetchWithAuth('/api/organizacoes/switch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ organizacao_id: orgId, expected_version: selectionVersion }),
      });
      const body = await response.json();
      if (!response.ok) {
        setError(body.error ?? 'Falha ao trocar de organização');
        return;
      }
      setActiveOrg(body.activeOrg ?? null);
      setSelectionVersion(body.selectionVersion ?? selectionVersion);
    } finally {
      setSwitchingOrgId(null);
    }
  }

  return {
    organizacoes,
    activeOrg,
    isLoading,
    error,
    switchingOrgId,
    loadOrganizacoes,
    handleCreateOrganization,
    handleSwitchOrganization,
  };
}
