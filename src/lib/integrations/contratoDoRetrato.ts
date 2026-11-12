import { z } from 'zod';

/**
 * Contrato HTTP v1 do retrato de um pedido do cliente confirmado (MSG-011).
 * Serve à tela do atendente e, depois, às ferramentas da automação: é a única
 * forma de ler itens, estoque, pagamento e rastreio de um pedido no atendimento.
 *
 * Desconhecido é um estado, não um zero: estoque sem produto, pagamento sem
 * título e rastreio sem fonte aparecem como `desconhecido`, nunca como 0,
 * "pago" ou "em aberto". Cada parte traz quando foi sincronizada e se isso é
 * recente o bastante para responder ao cliente. Documento, telefone e endereço
 * não atravessam este contrato. Os objetos são estritos: campo a mais é recusa.
 */
export const VERSAO_DO_CONTRATO_DO_RETRATO = 1;

export const FrescorSchema = z.strictObject({
  situacao: z.enum(['atual', 'desatualizado', 'desconhecido']),
  sincronizadoEm: z.string().nullable(),
  /** Por que não está `atual`; `null` quando está. */
  motivo: z.enum(['sem_sincronizacao', 'antiga', 'ultima_sincronizacao_falhou']).nullable(),
});
export type Frescor = z.infer<typeof FrescorSchema>;

export const EstoqueDoItemSchema = z.strictObject({
  /** `desconhecido`: o item não tem produto desta organização (órfão). */
  situacao: z.enum(['disponivel', 'indisponivel', 'inativo', 'arquivado', 'desconhecido']),
  /** Saldo menos reservas, só para produto ativo; `null` nos demais casos. */
  disponivel: z.number().int().nonnegative().nullable(),
});
export type EstoqueDoItem = z.infer<typeof EstoqueDoItemSchema>;

export const ItemDoRetratoSchema = z.strictObject({
  id: z.string().uuid(),
  produtoId: z.string().uuid().nullable(),
  nome: z.string(),
  codigo: z.string().nullable(),
  quantidade: z.number().int().positive(),
  valorUnitario: z.number().nonnegative(),
  estoque: EstoqueDoItemSchema,
});
export type ItemDoRetrato = z.infer<typeof ItemDoRetratoSchema>;

export const PagamentoDoRetratoSchema = z.strictObject({
  /** Do título a receber do pedido. Sem título, `desconhecido`; forma de pagamento não prova nada. */
  situacao: z.enum(['pago', 'parcial', 'em_aberto', 'cancelado', 'devolvido', 'desconhecido']),
  vencido: z.boolean(),
  valor: z.number().nonnegative().nullable(),
  vencimento: z.string().nullable(),
  pagoEm: z.string().nullable(),
});
export type PagamentoDoRetrato = z.infer<typeof PagamentoDoRetratoSchema>;

export const RetratoDoPedidoSchema = z.strictObject({
  pedido: z.strictObject({
    id: z.string().uuid(),
    numero: z.string().nullable(),
    data: z.string(),
    status: z.string(),
    total: z.number().nonnegative(),
    frete: z.number().nullable(),
    desconto: z.number().nullable(),
    formaDePagamento: z.string().nullable(),
  }),
  itens: z.array(ItemDoRetratoSchema).max(50),
  totalDeItens: z.number().int().nonnegative(),
  /** Itens além dos 50 devolvidos. */
  itensOmitidos: z.number().int().nonnegative(),
  pagamento: PagamentoDoRetratoSchema,
  /** O ORBITA não guarda rastreio: sempre desconhecido, até existir uma fonte. */
  rastreio: z.strictObject({ situacao: z.literal('desconhecido'), motivo: z.literal('sem_fonte') }),
  frescor: z.strictObject({ pedido: FrescorSchema, estoque: FrescorSchema, pagamento: FrescorSchema }),
});
export type RetratoDoPedido = z.infer<typeof RetratoDoPedidoSchema>;

export const RespostaDoRetratoSchema = z.strictObject({
  success: z.literal(true),
  versao: z.literal(VERSAO_DO_CONTRATO_DO_RETRATO),
  retrato: RetratoDoPedidoSchema,
});
export type RespostaDoRetrato = z.infer<typeof RespostaDoRetratoSchema>;
