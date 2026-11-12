import { z } from 'zod';

/**
 * Contrato HTTP v1 da verificação do cliente na conversa (MSG-010). O servidor
 * valida o que devolve; a tela valida o que recebe. Documento inteiro, telefone
 * e endereço não atravessam este contrato: do documento, só os dois últimos
 * dígitos, e só para o atendente escolher entre candidatos.
 */
export const VERSAO_DO_CONTRATO_DA_VERIFICACAO = 1;

export const CandidatoSchema = z.object({
  clienteId: z.string().uuid(),
  nome: z.string(),
  documentoFinal: z.string().regex(/^\d{2}$/u).nullable(),
});
export type Candidato = z.infer<typeof CandidatoSchema>;

export const VerificacaoSchema = z.object({
  /** `expirada`: houve confirmação, mas ela deixou de valer (prazo, caso fechado ou cliente anonimizado). */
  estado: z.enum(['sem_prova', 'verificado', 'expirada']),
  cliente: z.object({ id: z.string().uuid(), nome: z.string() }).nullable(),
  verificadoEm: z.string().nullable(),
  expiraEm: z.string().nullable(),
  /** Clientes da organização com o telefone do contato. Candidato não é vínculo. */
  totalDeCandidatos: z.number().int().nonnegative(),
  /** A consulta por número parou depois de tentativas seguidas sem resultado. */
  consultaPorNumeroBloqueada: z.boolean(),
});
export type Verificacao = z.infer<typeof VerificacaoSchema>;

export const RespostaDaVerificacaoSchema = z.object({
  success: z.literal(true),
  versao: z.literal(VERSAO_DO_CONTRATO_DA_VERIFICACAO),
  verificacao: VerificacaoSchema,
  candidatos: z.array(CandidatoSchema),
});
export type RespostaDaVerificacao = z.infer<typeof RespostaDaVerificacaoSchema>;

/** O mínimo de um pedido para o atendimento: sem itens, endereço ou pagamento (MSG-011). */
export const PedidoDoClienteSchema = z.object({
  id: z.string().uuid(),
  numero: z.string().nullable(),
  data: z.string(),
  status: z.string(),
  total: z.number(),
});
export type PedidoDoCliente = z.infer<typeof PedidoDoClienteSchema>;

export const RespostaDosPedidosSchema = z.object({
  success: z.literal(true),
  versao: z.literal(VERSAO_DO_CONTRATO_DA_VERIFICACAO),
  pedidos: z.array(PedidoDoClienteSchema),
});
export type RespostaDosPedidos = z.infer<typeof RespostaDosPedidosSchema>;
