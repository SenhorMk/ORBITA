import { z } from "zod";

/*
 * `BlingProductSchema` foi REMOVIDO.
 *
 * Ele mantinha uma segunda cópia dos enums do produto — `tipo` P|S,
 * `formato` S|V — ao lado do contrato compartilhado
 * (`lib/config/produtoContract.ts`), que transcreve o OpenAPI oficial:
 * `tipo` S|P|N, `formato` S|V|E. As duas cópias divergiram, e o formulário
 * passou a oferecer um valor ("Composição") que o validador local recusava.
 *
 * A validação do produto deriva agora de `produtoRequestSchema`. Um enum só,
 * num lugar só.
 */

export const BlingContactSchema = z.object({
  nome: z.string().min(1, "O nome do contato é obrigatório").max(120, "O nome não pode ter mais de 120 caracteres"),
  tipo: z.enum(["F", "J", "E"], { message: "O tipo deve ser 'F' (Física), 'J' (Jurídica) ou 'E' (Estrangeiro)" }),
  contribuinte: z.union([z.literal(1), z.literal(2), z.literal(9)]),
  email: z.string().email("E-mail inválido").optional().or(z.literal("")),
  fone: z.string().max(16, "O telefone não pode ter mais de 16 caracteres").optional().or(z.literal("")),
  numeroDocumento: z.string().max(20, "O documento (CPF/CNPJ) não pode ter mais de 20 caracteres").optional().or(z.literal("")),
});

export type BlingContactInput = z.infer<typeof BlingContactSchema>;
