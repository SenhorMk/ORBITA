import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { DesfechoDaAplicacao, EventoReivindicado, PortaDoConsumidorInbox } from './consumidorInboxChatwoot';

const EventoSchema = z.object({
  evento_id: z.string().uuid(),
  organizacao_id: z.string().uuid(),
  conexao_id: z.string().uuid().nullable(),
  inbox_id: z.coerce.number().int().nullable(),
  event_type: z.string().min(1),
  payload: z.unknown(),
  correlation_id: z.string().nullable(),
  fencing_token: z.coerce.number().int(),
  tentativa: z.number().int(),
});

const AplicacaoSchema = z.object({
  desfecho: z.enum(['aplicado', 'posse_perdida', 'conexao_desligada']),
  disposicao: z.enum([
    'caso_aberto', 'mensagem_no_caso', 'espelho_atualizado', 'revisao_atrasada',
    'conversa_nao_espelhada', 'conexao_nao_comprovada', 'classificacao_inconclusiva', 'evento_desconhecido', 'conexao_removida',
  ]).nullable(),
  caso_id: z.string().uuid().nullable(),
});

/** Um erro sem SQLSTATE veio do caminho até o banco: o commit é desconhecido. */
function codigoDoBanco(error: { readonly code?: string }): string | null {
  return error.code && /^[0-9A-Z]{5}$/.test(error.code) ? error.code : null;
}

/**
 * Porta do consumidor sobre o cliente `service_role`, restrita às três RPCs.
 * As funções tiram organização e conexão da própria linha da inbox.
 */
export function criarPortaDoConsumidorInbox(supabase: SupabaseClient): PortaDoConsumidorInbox {
  return {
    async reivindicar(workerId, limite, leaseSegundos, recebidosDesde) {
      const { data, error } = await supabase.rpc('reivindicar_eventos_inbox_chatwoot', {
        p_worker: workerId,
        p_limite: limite,
        p_lease_segundos: leaseSegundos,
        p_recebidos_desde: recebidosDesde,
      });
      if (error) throw new Error(`Claim da inbox falhou (${error.code ?? 'sem-codigo'}).`);
      return z.array(EventoSchema).parse(data ?? []).map((l): EventoReivindicado => ({
        eventoId: l.evento_id,
        organizacaoId: l.organizacao_id,
        conexaoId: l.conexao_id,
        inboxId: l.inbox_id,
        eventType: l.event_type,
        payload: l.payload,
        correlationId: l.correlation_id,
        fencingToken: l.fencing_token,
        tentativa: l.tentativa,
      }));
    },

    async aplicar(evento, workerId, comando): Promise<DesfechoDaAplicacao> {
      const { data, error } = await supabase.rpc('aplicar_evento_inbox_chatwoot', {
        p_evento_id: evento.eventoId,
        p_worker: workerId,
        p_fencing_token: evento.fencingToken,
        p_comando: comando,
      });
      if (error) {
        const codigo = codigoDoBanco(error);
        if (codigo === null) throw new Error('Sem resposta conclusiva do banco ao aplicar o evento.');
        return { _tag: 'FalhaDaTransacao', codigo };
      }
      const linha = AplicacaoSchema.parse(Array.isArray(data) ? data[0] : data);
      if (linha.desfecho === 'posse_perdida') return { _tag: 'PossePerdida' };
      if (linha.desfecho === 'conexao_desligada') return { _tag: 'ConexaoDesligada' };
      if (linha.disposicao === null) throw new Error('Aplicação sem disposição.');
      return { _tag: 'Aplicado', disposicao: linha.disposicao, casoId: linha.caso_id };
    },

    async registrarFalha(evento, workerId, codigo, definitiva) {
      const { data, error } = await supabase.rpc('registrar_falha_evento_inbox_chatwoot', {
        p_evento_id: evento.eventoId,
        p_worker: workerId,
        p_fencing_token: evento.fencingToken,
        p_codigo: codigo,
        p_definitiva: definitiva,
      });
      if (error) throw new Error(`Registro da falha da inbox não gravou (${error.code ?? 'sem-codigo'}).`);
      return typeof data === 'string';
    },
  };
}
