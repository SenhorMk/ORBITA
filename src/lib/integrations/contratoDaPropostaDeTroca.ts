import { z } from 'zod';

const id = z.string().uuid();
export const SolicitacaoDeTrocaSchema = z.strictObject({
  conversaId: id,
  tipo: z.enum(['troca', 'devolucao']),
  pedidoId: id.optional(),
  itemId: id.optional(),
  quantidade: z.number().int().positive().max(10_000).optional(),
  motivo: z.enum(['avaria', 'defeito', 'arrependimento', 'outro']).optional(),
  substitutoPretendido: z.string().trim().min(1).max(120).optional(),
}).refine((p) => p.itemId === undefined || p.pedidoId !== undefined, {
  message: 'O item exige um pedido selecionado.',
});
export type SolicitacaoDeTroca = z.infer<typeof SolicitacaoDeTrocaSchema>;

export const PendenciaDaTrocaSchema = z.enum([
  'pedido', 'item', 'quantidade', 'quantidade_excede_item', 'motivo', 'substituto', 'confirmar_cliente', 'frescor', 'ranking', 'politica',
]);
export type PendenciaDaTroca = z.infer<typeof PendenciaDaTrocaSchema>;

export const ProximaPerguntaDaTrocaSchema = z.strictObject({
  campo: z.enum(['pedido', 'item', 'quantidade', 'motivo', 'substituto']),
  pergunta: z.string().trim().min(1).max(160),
});

const itemVerificado = z.strictObject({
  id,
  nome: z.string(),
  quantidadeComprada: z.number().int().positive(),
  precoUnitarioCentavos: z.number().int().nonnegative(),
  moeda: z.literal('BRL'),
});

export const PreviaDaTrocaSchema = z.strictObject({
  versao: z.literal(1),
  casoId: id,
  conversaId: id,
  tipo: z.enum(['troca', 'devolucao']),
  estado: z.enum(['incompleta', 'requer_compatibilidade', 'requer_politica']),
  pendencias: z.array(PendenciaDaTrocaSchema),
  proximaPergunta: ProximaPerguntaDaTrocaSchema.nullable(),
  pedido: z.strictObject({
    id,
    numero: z.string().nullable(),
    sincronizadoEm: z.string(),
    fonte: z.literal('espelho_bling'),
    item: itemVerificado.nullable(),
  }).nullable(),
  quantidadeSolicitada: z.number().int().positive().nullable(),
  motivo: z.enum(['avaria', 'defeito', 'arrependimento', 'outro']).nullable(),
  substitutoPretendido: z.string().nullable(),
  rastreio: z.literal('sem_fonte'),
  podeAprovar: z.literal(false),
});
export type PreviaDaTroca = z.infer<typeof PreviaDaTrocaSchema>;
