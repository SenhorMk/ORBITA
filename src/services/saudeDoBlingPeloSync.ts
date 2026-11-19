import { supabaseServer } from '../lib/supabaseServer';
import { registrarFalhaInterna } from '../lib/observability/falhaInterna';
import type { VerifiedOrganizationScope } from '../lib/verifiedOrganizationScope';
import { outboxService } from './outboxService';

/** Texto público da saúde quando o sync falha: nunca o diagnóstico interno (CWE-209). */
export const ERRO_PUBLICO_DO_SYNC_NA_SAUDE = 'A última sincronização com o Bling falhou.';

/**
 * Um sync que termina é uma verificação real da conexão Bling: leu contatos,
 * produtos e pedidos com o token gravado. Antes, só a outbox gravava saúde, e
 * a tela de Integrações dizia "Não verificado" mesmo com o sync funcionando.
 *
 * Melhor esforço: a saúde é a última notícia, não parte do resultado do sync.
 * Uma falha aqui é registrada e engolida, nunca muda o desfecho do job.
 */
export async function registrarSaudeDoBlingPeloSync(
  scope: VerifiedOrganizationScope,
  desfecho: 'healthy' | 'error',
): Promise<void> {
  try {
    const { data, error } = await supabaseServer
      .from('conexoes_integracao')
      .select('id')
      .eq('organizacao_id', scope.organizationId)
      .eq('provedor', 'bling')
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data?.id) return;

    await outboxService.updateConnectionHealth(
      supabaseServer,
      scope,
      data.id,
      desfecho,
      desfecho === 'error' ? ERRO_PUBLICO_DO_SYNC_NA_SAUDE : undefined,
    );
  } catch (err: unknown) {
    registrarFalhaInterna('sync.saude_do_bling', err, { organizacaoId: scope.organizationId });
  }
}

/** O desfecho `JobFinished` do sync, depois de registrar a saúde que ele provou. */
export async function jobConcluidoComSaude(
  scope: VerifiedOrganizationScope,
  desfecho: 'healthy' | 'error',
): Promise<{ readonly _tag: 'JobFinished' }> {
  await registrarSaudeDoBlingPeloSync(scope, desfecho);
  return { _tag: 'JobFinished' };
}
