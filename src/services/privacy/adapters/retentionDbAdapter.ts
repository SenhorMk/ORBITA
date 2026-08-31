/**
 * retentionDbAdapter.ts
 * Ticket 18: adapter do sistema "banco" para o mecanismo de retenção —
 * mesmo padrão de `dbAdapter.ts` (ticket 17): a decisão de tradução
 * `RetentionEffectAdapter` é uma classe fina sobre uma porta explícita
 * (`RetentionDatabasePort`); a implementação real (`SupabaseRetentionDatabasePort`)
 * só traduz porta -> RPC do Supabase (`database/51_retencao_anonimizacao_eliminacao.sql`)
 * e não é testada unitariamente aqui — comportamento coberto pelo pgTAP
 * (`supabase/tests/database/retencao.test.sql`).
 *
 * `preview` (dry-run) NUNCA chama uma RPC de efeito (`retencao_aplicar_*`) —
 * só confirma que a entidade ainda existe e é elegível, sem gravar nada.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { RetentionAction, RetentionEffectAdapter, RetentionEffectContext, RetentionItemOutcome } from './retentionTypes';
import { descreverErro } from '../../../lib/erroLegivel';

export interface RetentionDatabasePort {
  entityExists(tabelaAlvo: string, organizationId: string, entidadeId: string): Promise<boolean>;
  applyAnonymization(
    runId: string,
    organizationId: string,
    categoria: string,
    tabelaAlvo: string,
    entidadeId: string,
  ): Promise<{ readonly applied: boolean }>;
  applyDeletion(
    runId: string,
    organizationId: string,
    categoria: string,
    tabelaAlvo: string,
    entidadeId: string,
  ): Promise<{ readonly applied: boolean }>;
}

/** Registry -> tabela alvo é uma decisão do chamador (o serviço de
 * orquestração já sabe a categoria/tabela ao montar o adapter); este adapter
 * recebe a tabela explicitamente via `RetentionEffectContext` estendido para
 * não duplicar consulta ao registry aqui. */
export interface RetentionDbEffectContext extends RetentionEffectContext {
  readonly tabelaAlvo: 'clientes' | 'chatwoot_contacts';
}

export class RetentionDbAdapter implements RetentionEffectAdapter {
  readonly sistema = 'banco' as const;

  constructor(private readonly port: RetentionDatabasePort) {}

  async preview(
    _action: RetentionAction,
    entidadeId: string,
    context: RetentionEffectContext,
  ): Promise<{ readonly wouldApply: boolean }> {
    const ctx = context as RetentionDbEffectContext;
    const exists = await this.port.entityExists(ctx.tabelaAlvo, context.organizationId, entidadeId);
    // Dry-run nunca grava nada — só reporta se a ação seria aplicada.
    return { wouldApply: exists };
  }

  async apply(action: RetentionAction, entidadeId: string, context: RetentionEffectContext): Promise<RetentionItemOutcome> {
    const ctx = context as RetentionDbEffectContext;
    try {
      if (action === 'anonymize') {
        const result = await this.port.applyAnonymization(
          context.runId,
          context.organizationId,
          context.categoria,
          ctx.tabelaAlvo,
          entidadeId,
        );
        if (!result.applied) return { status: 'retryable', motivo: 'Anonimizacao recusada (legal hold ativo).' };
        return { status: 'done' };
      }
      if (action === 'delete') {
        const result = await this.port.applyDeletion(
          context.runId,
          context.organizationId,
          context.categoria,
          ctx.tabelaAlvo,
          entidadeId,
        );
        if (!result.applied) return { status: 'retryable', motivo: 'Exclusao recusada (legal hold ativo).' };
        return { status: 'done' };
      }
      return { status: 'failed', erro: `Acao de retencao nao suportada pelo adapter de banco: ${action}` };
    } catch (err) {
      // Nunca um catch vazio: exceção inesperada vira `failed` com o erro
      // registrado, nunca é engolida silenciosamente.
      return { status: 'failed', erro: descreverErro(err) };
    }
  }
}

/** Implementação real (Supabase, service role) da porta de banco. Thin
 * passthrough para as RPCs `security definer` da migration 51 — não
 * unitariamente testada aqui (mesmo padrão de `SupabaseTitularDatabasePort`). */
export class SupabaseRetentionDatabasePort implements RetentionDatabasePort {
  constructor(private readonly supabase: SupabaseClient) {}

  async entityExists(tabelaAlvo: string, organizationId: string, entidadeId: string): Promise<boolean> {
    const table = tabelaAlvo === 'clientes' ? 'clientes' : 'chatwoot_contacts';
    const idColumn = 'id';
    const { count, error } = await this.supabase
      .from(table)
      .select(idColumn, { count: 'exact', head: true })
      .eq(idColumn, tabelaAlvo === 'clientes' ? entidadeId : Number(entidadeId))
      .eq('organizacao_id', organizationId);
    if (error) throw new Error(`Falha ao checar existencia da entidade de retencao: ${error.message}`);
    return (count ?? 0) > 0;
  }

  async applyAnonymization(
    runId: string,
    organizationId: string,
    categoria: string,
    tabelaAlvo: string,
    entidadeId: string,
  ): Promise<{ readonly applied: boolean }> {
    return this.callEffectRpc('retencao_aplicar_anonimizacao', runId, organizationId, categoria, tabelaAlvo, entidadeId);
  }

  async applyDeletion(
    runId: string,
    organizationId: string,
    categoria: string,
    tabelaAlvo: string,
    entidadeId: string,
  ): Promise<{ readonly applied: boolean }> {
    return this.callEffectRpc('retencao_aplicar_exclusao', runId, organizationId, categoria, tabelaAlvo, entidadeId);
  }

  /** As duas RPCs de efeito (`retencao_aplicar_anonimizacao`/`retencao_aplicar_exclusao`) têm a
   * mesma assinatura e o mesmo contrato de retorno (`boolean` — recusado quando há legal hold
   * ativo) — extraído para não duplicar a chamada Supabase. */
  private async callEffectRpc(
    rpcName: 'retencao_aplicar_anonimizacao' | 'retencao_aplicar_exclusao',
    runId: string,
    organizationId: string,
    categoria: string,
    tabelaAlvo: string,
    entidadeId: string,
  ): Promise<{ readonly applied: boolean }> {
    const { data, error } = await this.supabase.rpc(rpcName, {
      p_run_id: runId,
      p_organizacao_id: organizationId,
      p_categoria: categoria,
      p_tabela_alvo: tabelaAlvo,
      p_entidade_id: entidadeId,
    });
    if (error) throw new Error(`Falha ao chamar ${rpcName}: ${error.message}`);
    return { applied: Boolean(data) };
  }
}
