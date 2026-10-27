import { z } from 'zod';

/**
 * Contrato HTTP v1 da outbox para o operador (MSG-007): a consulta de efeitos
 * que pedem atenção e as decisões sobre um efeito desconhecido. O servidor
 * valida o que devolve; a tela valida o que recebe. Nenhum payload ou
 * conteúdo de mensagem atravessa este contrato.
 */
export const VERSAO_DO_CONTRATO_DA_OUTBOX = 1;

export const TentativaDaOutboxSchema = z.object({
  fencingToken: z.number().int(),
  desfecho: z.enum(['em_voo', 'confirmado', 'recusado', 'nao_enviado', 'desconhecido']),
  motivo: z.string().nullable(),
  iniciadaEm: z.string(),
  concluidaEm: z.string().nullable(),
});

export const EventoDaOutboxSchema = z.object({
  id: z.string().uuid(),
  destino: z.string(),
  tipo: z.string(),
  status: z.enum(['pending', 'processing', 'in_flight', 'sent', 'failed_transient', 'dead_letter', 'unknown']),
  desfecho: z.enum(['nao_enviado', 'recusado', 'confirmado', 'desconhecido', 'em_andamento']),
  motivoBloqueio: z.string().nullable(),
  resolucao: z.string().nullable(),
  tentativasContadas: z.number().int(),
  podeRepetir: z.boolean(),
  explicacao: z.string(),
  atualizadoEm: z.string(),
  tentativas: z.array(TentativaDaOutboxSchema),
});
export type EventoDaOutbox = z.infer<typeof EventoDaOutboxSchema>;

export const RespostaDaOutboxSchema = z.object({
  success: z.literal(true),
  versao: z.literal(VERSAO_DO_CONTRATO_DA_OUTBOX),
  eventos: z.array(EventoDaOutboxSchema),
});

/** O pedido de decisão: reconciliar com prova, ou autorizar o replay. */
const ReconciliacaoSchema = z.discriminatedUnion('resolucao', [
  z.object({
    acao: z.literal('reconciliar'),
    resolucao: z.literal('confirmado'),
    reciboRef: z.string().trim().min(1).max(200),
    evidencia: z.string().trim().min(1).max(500).optional(),
  }),
  z.object({
    acao: z.literal('reconciliar'),
    resolucao: z.literal('provado_nao_aplicado'),
    evidencia: z.string().trim().min(10).max(500),
  }),
  z.object({
    acao: z.literal('reconciliar'),
    resolucao: z.literal('revisao_manual'),
    evidencia: z.string().trim().min(1).max(500).optional(),
  }),
]);

export const DecisaoDaOutboxSchema = z.union([z.object({ acao: z.literal('replay') }), ReconciliacaoSchema]);
export type DecisaoDaOutbox = z.infer<typeof DecisaoDaOutboxSchema>;
