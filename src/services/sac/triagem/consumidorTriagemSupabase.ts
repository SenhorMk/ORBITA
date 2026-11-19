/**
 * A porta real do consumidor de triagem (MSG-013): as RPCs da migration 94.
 * O cliente é `service_role`, que ignora RLS; cada RPC é presa ao evento
 * reivindicado e à sua organização, e toda resposta é validada. Resposta fora
 * do contrato é erro, nunca triagem.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

import type {
  ConclusaoDaTriagem,
  InicioDaTriagem,
  PortaDoConsumidorTriagem,
  ResultadoDaConclusao,
  TriagemReivindicada,
} from './consumidorTriagem';

const ReivindicadaSchema = z.array(z.object({
  evento_id: z.string().uuid(),
  organizacao_id: z.string().uuid(),
  caso_id: z.string().uuid(),
  correlation_id: z.string().nullable(),
  fencing_token: z.coerce.number().int().positive(),
}));

const InicioSchema = z.discriminatedUnion('resultado', [
  z.object({
    resultado: z.literal('iniciada'),
    run_id: z.string().uuid(),
    mensagens: z.array(z.object({ conteudo: z.string(), criada_em: z.string() })).max(5),
  }),
  z.object({ resultado: z.enum(['obsoleta', 'sem_orcamento', 'caso_inexistente', 'posse_perdida']) }),
]);

const ConclusaoSchema = z.enum(['concluida', 'handoff', 'falha', 'obsoleta', 'posse_perdida']);

export class FilaDeTriagemIndisponivel extends Error {
  constructor(operacao: string) {
    super(`Fila de triagem indisponível: ${operacao}.`);
    this.name = 'FilaDeTriagemIndisponivel';
  }
}

export function criarPortaDoConsumidorTriagem(supabase: SupabaseClient): PortaDoConsumidorTriagem {
  return {
    async liberarLeasesVencidas() {
      const { data, error } = await supabase.rpc('liberar_leases_expirados_outbox');
      if (error) throw new FilaDeTriagemIndisponivel('liberar leases');
      return Array.isArray(data) ? data.length : 0;
    },

    async reivindicar({ workerId, limite, leaseSegundos }): Promise<readonly TriagemReivindicada[]> {
      const { data, error } = await supabase.rpc('reivindicar_triagens_sac', {
        p_worker_id: workerId, p_limite: limite, p_lease_ttl_sec: leaseSegundos,
      });
      if (error) throw new FilaDeTriagemIndisponivel('reivindicar');
      const lido = ReivindicadaSchema.safeParse(data);
      if (!lido.success) throw new FilaDeTriagemIndisponivel('reivindicar');
      return lido.data.map((l) => ({
        eventoId: l.evento_id, organizacaoId: l.organizacao_id, casoId: l.caso_id, correlationId: l.correlation_id, fencingToken: l.fencing_token,
      }));
    },

    async iniciar(item, pedido): Promise<InicioDaTriagem> {
      const { data, error } = await supabase.rpc('iniciar_triagem_sac', {
        p_evento_id: item.eventoId,
        p_worker_id: pedido.workerId,
        p_fencing_token: item.fencingToken,
        p_limite_diario: pedido.limiteDiario,
        p_provedor: pedido.provedor,
        p_modelo: pedido.modelo,
        p_versao_prompt: pedido.versaoPrompt,
        p_versao_schema: pedido.versaoSchema,
      });
      if (error) throw new FilaDeTriagemIndisponivel('iniciar');
      const lido = InicioSchema.safeParse(data);
      if (!lido.success) throw new FilaDeTriagemIndisponivel('iniciar');
      if (lido.data.resultado !== 'iniciada') return { _tag: 'Encerrada', motivo: lido.data.resultado };
      return {
        _tag: 'Iniciada',
        runId: lido.data.run_id,
        mensagens: lido.data.mensagens.map((m) => ({ conteudo: m.conteudo, criadaEm: m.criada_em })),
      };
    },

    async concluir(runId: string, workerId: string, fencingToken: number, c: ConclusaoDaTriagem): Promise<ResultadoDaConclusao> {
      const { data, error } = await supabase.rpc('concluir_triagem_sac', {
        p_run_id: runId,
        p_worker_id: workerId,
        p_fencing_token: fencingToken,
        p_status: c.status,
        p_motivo: c.motivo,
        p_resultado: c.triagem,
        p_chamou_modelo: c.chamouModelo,
        p_tokens_entrada: c.tokensEntrada,
        p_tokens_saida: c.tokensSaida,
        p_reparos: c.reparos,
        p_latencia_ms: c.latenciaMs,
        p_retry_delay_sec: c.repetirEmSegundos,
      });
      if (error) throw new FilaDeTriagemIndisponivel('concluir');
      const lido = ConclusaoSchema.safeParse(data);
      if (!lido.success) throw new FilaDeTriagemIndisponivel('concluir');
      return lido.data;
    },
  };
}
