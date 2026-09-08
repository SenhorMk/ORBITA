import { useCallback, useEffect, useState } from 'react';
import type { ActiveOrg, Organizacao } from './types';
import type { AuthenticatedFetch } from './useOrganizationPanel';

/**
 * Carrega, cria e troca organizações (`/api/organizacoes`,
 * `/api/organizacoes/switch`).
 *
 * `selectionVersion` sai daqui porque a tela precisa dela: trocar de
 * organização e voltar para a mesma são seleções diferentes, e é a versão que
 * separa uma da outra.
 *
 * @param habilitado - Se pode consultar o servidor. Existe porque, desde o
 *   Ticket 01, este estado é criado uma vez no topo da aplicação para servir
 *   tanto o indicador do shell quanto o painel de organização — e o topo da
 *   aplicação também renderiza a tela de login, onde não há sessão e
 *   `fetchWithAuth` lança. Sem sessão não se pergunta nada.
 */
export function useOrganizationsList(fetchWithAuth: AuthenticatedFetch, habilitado: boolean = true) {
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
    if (!habilitado) return;
    let isMounted = true;
    void (async () => {
      setIsLoading(true);
      await loadOrganizacoes();
      if (isMounted) setIsLoading(false);
    })();
    return () => {
      isMounted = false;
    };
  }, [loadOrganizacoes, habilitado]);

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
    selectionVersion,
    isLoading,
    error,
    switchingOrgId,
    loadOrganizacoes,
    handleCreateOrganization,
    handleSwitchOrganization,
  };
}
