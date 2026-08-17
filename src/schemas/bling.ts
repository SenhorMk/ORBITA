import { z } from "zod";

export const BlingProductSchema = z.object({
  nome: z.string().min(1, "O nome do produto é obrigatório").max(120, "O nome não pode ter mais de 120 caracteres"),
  tipo: z.enum(["P", "S"], { message: "O tipo deve ser 'P' (Produto) ou 'S' (Serviço)" }),
  situacao: z.enum(["A", "I"], { message: "A situação deve ser 'A' (Ativo) ou 'I' (Inativo)" }),
  formato: z.enum(["S", "V"], { message: "O formato deve ser 'S' (Simples) ou 'V' (Variações)" }),
  preco: z.coerce.number().min(0, "O preço deve ser no mínimo 0"),
  unidade: z.string().min(1, "A unidade é obrigatória (ex: UN, PÇ, KG)").max(6, "A unidade deve ter no máximo 6 caracteres"),
  codigo: z.string().max(60, "O código (SKU) não pode ter mais de 60 caracteres").optional(),
});

export type BlingProductInput = z.infer<typeof BlingProductSchema>;

export const BlingContactSchema = z.object({
  nome: z.string().min(1, "O nome do contato é obrigatório").max(120, "O nome não pode ter mais de 120 caracteres"),
  tipo: z.enum(["F", "J", "E"], { message: "O tipo deve ser 'F' (Física), 'J' (Jurídica) ou 'E' (Estrangeiro)" }),
  contribuinte: z.union([z.literal(1), z.literal(2), z.literal(9)]),
  email: z.string().email("E-mail inválido").optional().or(z.literal("")),
  fone: z.string().max(16, "O telefone não pode ter mais de 16 caracteres").optional().or(z.literal("")),
  numeroDocumento: z.string().max(20, "O documento (CPF/CNPJ) não pode ter mais de 20 caracteres").optional().or(z.literal("")),
});

export type BlingContactInput = z.infer<typeof BlingContactSchema>;
