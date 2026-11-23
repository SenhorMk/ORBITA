import { z } from 'zod';

const id = z.string().uuid();
const quantidade = z.number().int().positive().max(10_000);

// Propostas validadas em memória. O modelo não escolhe ator, empresa ou autorização.
export const propostasAdministrativas = z.discriminatedUnion('tipo', [
  z.object({ tipo: z.literal('preparar_pedido'), clienteId: id,
    itens: z.array(z.object({ produtoId: id, quantidade }).strict()).min(1).max(50) }).strict(),
  z.object({ tipo: z.literal('preparar_ajuste_estoque'), produtoId: id, quantidade,
    movimento: z.enum(['entrada', 'saida']), motivo: z.string().trim().min(1).max(200) }).strict(),
  z.object({ tipo: z.literal('preparar_devolucao'), pedidoId: id,
    itens: z.array(z.object({ itemId: id, quantidade }).strict()).min(1).max(50),
    motivo: z.string().trim().min(1).max(200) }).strict(),
]);

export type PropostaAdministrativa = z.infer<typeof propostasAdministrativas>;
