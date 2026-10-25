import type { SupabaseClient } from '@supabase/supabase-js';

import { verifyOrganizationScope, type VerifiedOrganizationScope } from '../lib/verifiedOrganizationScope';
import { recordAuditEvent } from './auditService';

/**
 * O rastro da (re)ativação de uma conexão de integração (PRE-008).
 *
 * Desde a migration 84 a API autorizada é o único caminho para configurar ou
 * reativar uma conexão: o navegador não escreve mais em `conexoes_integracao`.
 * Estes eventos registram quem fez, em qual organização, em qual conexão e o
 * status resultante. A metadata nunca leva token, segredo nem nada do cofre.
 */
export type EventoDeConexao = 'integration.connection_configured' | 'integration.connection_authorized';

export interface ConexaoAuditada {
  readonly provedor: 'bling' | 'chatwoot';
  readonly conexaoId: string;
  readonly status: 'pendente' | 'conectado';
  readonly correlationId: string;
}

/** Grava o evento com o escopo já verificado. Lança se a auditoria recusar. */
export async function auditarConexao(
  supabase: SupabaseClient,
  scope: VerifiedOrganizationScope,
  evento: EventoDeConexao,
  conexao: ConexaoAuditada,
): Promise<void> {
  await recordAuditEvent(supabase, scope, {
    acao: evento,
    recurso: 'conexoes_integracao',
    recursoId: conexao.conexaoId,
    correlationId: conexao.correlationId,
    metadata: { provedor: conexao.provedor, status: conexao.status },
  });
}

/**
 * Para o callback OAuth, que não tem sessão: a organização e o ator vêm da
 * transação OAuth consumida, e o par é verificado de novo aqui. Um ator que
 * saiu da organização entre o authorize e o callback não autoriza nada.
 */
export async function auditarAutorizacaoOAuth(
  supabase: SupabaseClient,
  candidato: { readonly organizationId: string; readonly actorId: string },
  conexao: ConexaoAuditada,
): Promise<void> {
  const verificado = await verifyOrganizationScope(supabase, candidato);
  if (verificado._tag !== 'OrganizationScopeVerified') {
    throw new Error(`Escopo da autorização OAuth não verificado: ${verificado._tag}`);
  }
  await auditarConexao(supabase, verificado.scope, 'integration.connection_authorized', conexao);
}
