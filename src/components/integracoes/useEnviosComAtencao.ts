import { useCallback } from 'react';

import { useLeituraPorOrganizacao, type LeituraPorOrganizacao } from '@/components/organizacao/useLeituraPorOrganizacao';
import type { SelecaoDeOrganizacao } from '@/components/organizacao/usePapelNaOrganizacaoAtiva';
import type { AuthenticatedFetch } from '@/components/organizacao/useOrganizationPanel';
import { RespostaDaOutboxSchema, type EventoDaOutbox } from '@/lib/integrations/contratoDaOutbox';
import { comPrazo } from './comPrazo';

/**
 * Os envios que pedem atenção (desconhecidos, recusados, em voo), por
 * organização, pelo mesmo mecanismo carimbado das demais leituras da tela.
 * Uma resposta fora do contrato é erro, não lista vazia: "nada pendente" e
 * "não foi possível saber" não podem parecer iguais.
 */
export function useEnviosComAtencao(
  fetchWithAuth: AuthenticatedFetch,
  selecao: SelecaoDeOrganizacao | null,
): LeituraPorOrganizacao<readonly EventoDaOutbox[]> {
  const ler = useCallback(async (): Promise<readonly EventoDaOutbox[]> => {
    const resposta = await comPrazo(fetchWithAuth, '/api/integracoes/outbox');
    if (!resposta.ok) {
      throw new Error(`Não foi possível ler os envios (HTTP ${resposta.status}).`);
    }
    const corpo = RespostaDaOutboxSchema.safeParse(await resposta.json());
    if (!corpo.success) throw new Error('O servidor respondeu em um formato inesperado.');
    return corpo.data.eventos;
  }, [fetchWithAuth]);

  return useLeituraPorOrganizacao(selecao, ler, 'Não foi possível ler os envios.');
}
