import { useCallback } from 'react';

import { useLeituraPorOrganizacao, type LeituraPorOrganizacao } from '@/components/organizacao/useLeituraPorOrganizacao';
import type { SelecaoDeOrganizacao } from '@/components/organizacao/usePapelNaOrganizacaoAtiva';
// A fronteira de busca autenticada é uma só no produto; declarar uma segunda
// com o mesmo nome é como as duas divergem.
import type { AuthenticatedFetch } from '@/components/organizacao/useOrganizationPanel';
import type { ConexaoObservada } from '@/lib/integrations/estadoDaIntegracao';
import { comPrazo } from './comPrazo';

/** Uma conexão como `/api/integracoes/saude` a devolve. */
export interface ConexaoDeIntegracao extends ConexaoObservada {
  readonly id: string;
  readonly provedor: string;
  readonly nome: string;
}

/** O que a tela de Integrações lê do servidor para uma organização. */
export interface LeituraDeIntegracoes {
  readonly conexoes: readonly ConexaoDeIntegracao[];
  /** URL de retorno do OAuth do Bling, decidida no servidor. `null` se falta configurar. */
  readonly blingCallbackUrl: string | null;
  /** URL do webhook do Chatwoot da conexão existente, decidida no servidor. */
  readonly chatwootWebhookUrl: string | null;
}

function conexoesDoCorpo(corpo: unknown): readonly ConexaoDeIntegracao[] {
  const lista = (corpo as { conexoes?: unknown })?.conexoes;
  // SAFETY: a rota é a nossa e devolve `IntegrationHealthSummary[]`; o que
  // chega aqui só é consumido pela derivação de estado, que valida cada campo.
  return Array.isArray(lista) ? (lista as ConexaoDeIntegracao[]) : [];
}

function textoOuNulo(valor: unknown): string | null {
  return typeof valor === 'string' && valor.length > 0 ? valor : null;
}

/**
 * A leitura de Integrações, **por organização**.
 *
 * Reusa `useLeituraPorOrganizacao` — o mesmo mecanismo de membros e convites do
 * Ticket 06 — e não uma segunda cópia dele. O carimbo (organização, versão) é
 * o que garante as duas metades: a leitura de A não é *exibida* sob B, e a
 * resposta atrasada de A não é *gravada* depois da troca.
 *
 * A leitura **lança** quando falha, de propósito: é o que distingue "não há
 * integração configurada" de "não foi possível saber". Numa tela cuja função é
 * dizer o estado das integrações, confundir as duas é o defeito principal.
 */
export function useIntegracoes(
  fetchWithAuth: AuthenticatedFetch,
  selecao: SelecaoDeOrganizacao | null,
): LeituraPorOrganizacao<LeituraDeIntegracoes> {
  const ler = useCallback(async (): Promise<LeituraDeIntegracoes> => {
    // Com prazo: sem ele, uma leitura travada deixa a tela em "Lendo o estado
    // das integracoes..." indefinidamente, sem nada que o lojista possa fazer.
    const resposta = await comPrazo(fetchWithAuth, '/api/integracoes/saude');
    if (!resposta.ok) {
      throw new Error(`Não foi possível ler o estado das integrações (HTTP ${resposta.status}).`);
    }
    const corpo = await resposta.json();
    return {
      conexoes: conexoesDoCorpo(corpo),
      blingCallbackUrl: textoOuNulo(corpo?.bling_callback_url),
      chatwootWebhookUrl: textoOuNulo(corpo?.chatwoot_webhook_url),
    };
  }, [fetchWithAuth]);

  return useLeituraPorOrganizacao(selecao, ler, 'Não foi possível ler o estado das integrações.');
}
