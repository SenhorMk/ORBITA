import { useCallback } from 'react';

import { useLeituraPorOrganizacao, type LeituraPorOrganizacao } from '@/components/organizacao/useLeituraPorOrganizacao';
import type { SelecaoDeOrganizacao } from '@/components/organizacao/usePapelNaOrganizacaoAtiva';
import type { AuthenticatedFetch } from '@/components/organizacao/useOrganizationPanel';
import { RespostaDaMensageriaSchema, type CasoSac, type EventoRecebido } from '@/lib/integrations/contratoDaMensageria';
import { comPrazo } from './comPrazo';

export interface LeituraDaMensageria {
  readonly eventos: readonly EventoRecebido[];
  readonly casos: readonly CasoSac[];
}

/**
 * As mensagens recebidas e os casos, por organização. Uma resposta fora do
 * contrato é erro, não lista vazia: "nada recebido" e "não foi possível saber"
 * não podem parecer iguais.
 */
export function useMensagensRecebidas(
  fetchWithAuth: AuthenticatedFetch,
  selecao: SelecaoDeOrganizacao | null,
): LeituraPorOrganizacao<LeituraDaMensageria> {
  const ler = useCallback(async (): Promise<LeituraDaMensageria> => {
    const resposta = await comPrazo(fetchWithAuth, '/api/sac/casos');
    if (!resposta.ok) {
      throw new Error(`Não foi possível ler as mensagens (HTTP ${resposta.status}).`);
    }
    const corpo = RespostaDaMensageriaSchema.safeParse(await resposta.json());
    if (!corpo.success) throw new Error('O servidor respondeu em um formato inesperado.');
    return { eventos: corpo.data.eventos, casos: corpo.data.casos };
  }, [fetchWithAuth]);

  return useLeituraPorOrganizacao(selecao, ler, 'Não foi possível ler as mensagens.');
}
