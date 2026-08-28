/**
 * logsAdapter.ts
 * Ticket 17: adapter do sistema "logs" — a trilha de auditoria imutável
 * (`public.eventos_auditoria_sistema`, migration 36).
 *
 * Acesso/exportação: leitura real, filtrada por organização e correlação com
 * o titular. Exclusão: **sempre** `retained_with_reason` — uma trilha de
 * auditoria que pudesse ser apagada sob demanda deixaria de provar nada;
 * este é um caso claro de retenção obrigatória (integridade da própria
 * trilha), não uma decisão de conveniência.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { AdapterOutcome, DireitoTipo, TitularSystemAdapter, TitularTaskContext } from './types';

export interface AuditoriaEventoRow {
  readonly id: string;
  readonly acao: string;
  readonly recurso: string;
  readonly recurso_id: string | null;
  readonly created_at: string;
}

export interface TitularLogsPort {
  findEventosPorAtor(organizationId: string, actorId: string): Promise<AuditoriaEventoRow[]>;
}

export const LOGS_RETENTION_FUNDAMENTO = 'trilha_auditoria_integridade_obrigatoria';

export class LogsAdapter implements TitularSystemAdapter {
  readonly sistema = 'logs' as const;

  constructor(private readonly port: TitularLogsPort) {}

  async execute(direito: DireitoTipo, context: TitularTaskContext): Promise<AdapterOutcome> {
    if (direito === 'exclusao' || direito === 'correcao') {
      return { status: 'retained_with_reason', fundamento: LOGS_RETENTION_FUNDAMENTO };
    }

    const actorId = context.titularRefUserId ?? context.titularRefClienteId;
    if (!actorId) return { status: 'failed', erro: 'Nenhuma referência de titular disponível para consultar logs.' };

    const eventos = await this.port.findEventosPorAtor(context.organizationId, actorId);
    if (eventos.length === 0) return { status: 'not_found' };

    return {
      status: 'completed',
      data: {
        eventos: eventos.map((e) => ({
          acao: e.acao,
          recurso: e.recurso,
          recurso_id: e.recurso_id,
          data: e.created_at,
        })),
      },
    };
  }
}

export class SupabaseTitularLogsPort implements TitularLogsPort {
  constructor(private readonly supabase: SupabaseClient) {}

  async findEventosPorAtor(organizationId: string, actorId: string): Promise<AuditoriaEventoRow[]> {
    const { data, error } = await this.supabase
      .from('eventos_auditoria_sistema')
      .select('id, acao, recurso, recurso_id, created_at')
      .eq('organizacao_id', organizationId)
      .eq('actor_id', actorId)
      .order('created_at', { ascending: false })
      .limit(500);
    if (error) throw new Error(`Falha ao consultar auditoria: ${error.message}`);
    return data ?? [];
  }
}
