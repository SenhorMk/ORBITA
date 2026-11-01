import { z } from 'zod';

/**
 * Contrato HTTP v1 da leitura do operador (MSG-006): as mensagens recebidas com o
 * estado na inbox e os casos SAC abertos. O servidor valida o que devolve; a tela
 * valida o que recebe. Nenhum conteúdo, nome ou telefone atravessa este contrato.
 */
export const VERSAO_DO_CONTRATO_DA_MENSAGERIA = 1;

export const EventoRecebidoSchema = z.object({
  id: z.string().uuid(),
  tipo: z.string(),
  estado: z.enum(['recebida', 'processando', 'processada', 'ignorada', 'falha_com_retentativa', 'falha_definitiva']),
  disposicao: z.string().nullable(),
  /** Código técnico da última falha; nunca texto livre. */
  motivo: z.string().nullable(),
  tentativas: z.number().int(),
  casoId: z.string().uuid().nullable(),
  recebidaEm: z.string(),
  processadaEm: z.string().nullable(),
});
export type EventoRecebido = z.infer<typeof EventoRecebidoSchema>;

export const CasoSacSchema = z.object({
  id: z.string().uuid(),
  fase: z.string(),
  versao: z.number().int(),
  conversaIdLocal: z.string().uuid(),
  abertoEm: z.string(),
  ultimaMensagemEm: z.string(),
});
export type CasoSac = z.infer<typeof CasoSacSchema>;

export const RespostaDaMensageriaSchema = z.object({
  success: z.literal(true),
  versao: z.literal(VERSAO_DO_CONTRATO_DA_MENSAGERIA),
  eventos: z.array(EventoRecebidoSchema),
  casos: z.array(CasoSacSchema),
});
