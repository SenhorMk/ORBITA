import { z } from 'zod';

/**
 * Contrato único do corpo de `POST /api/clientes/update`.
 *
 * Quarto da série (`blingCredentialsContract`, `manualOrderContract`,
 * `produtoContract`), pelo mesmo motivo de sempre: a rota lia o corpo com
 * `body as Partial<Cliente>` — um cast, não uma validação.
 */

/** `tipo` de contato no Bling: `J` Jurídica, `F` Física, `E` Estrangeira. */
export const contatoTipoSchema = z.enum(['J', 'F', 'E']);
export type ContatoTipo = z.infer<typeof contatoTipoSchema>;

/**
 * `indicadorIe` do Bling: `1` Contribuinte ICMS, `2` Contribuinte isento,
 * `9` Não contribuinte.
 *
 * O código anterior enviava um campo `contribuinte`, que **não existe** no
 * schema oficial — o valor era descartado silenciosamente pelo provedor.
 */
export const indicadorIeSchema = z.union([z.literal(1), z.literal(2), z.literal(9)]);
export type IndicadorIe = z.infer<typeof indicadorIeSchema>;

/**
 * Tipo de pessoa e indicador de IE de um contato, ambos escolhidos por alguém.
 *
 * São independentes: `J` não implica `1`, e o documento não implica nenhum dos
 * dois. Sem os dois, o contato não é cadastrado no Bling (PRE-010).
 */
export const dadosFiscaisDoContatoSchema = z.object({
  tipo: contatoTipoSchema,
  indicadorIe: indicadorIeSchema,
});
export type DadosFiscaisDoContato = z.infer<typeof dadosFiscaisDoContatoSchema>;

/** Apenas dígitos, para validar CPF (11) e CNPJ (14). */
function apenasDigitos(valor: string): string {
  return valor.replace(/\D/gu, '');
}

export const clienteRequestSchema = z
  .object({
    id: z.string().uuid().optional(),
    /** Id do contato no Bling, quando já sincronizado. Só id numérico real. */
    blingId: z.string().regex(/^\d+$/u, 'blingId deve ser o id numérico do Bling').optional(),
    nome: z.string().trim().min(1, 'O nome do cliente é obrigatório').max(120),
    email: z.string().trim().email('E-mail inválido').max(120).optional().or(z.literal('')),
    telefone: z.string().trim().max(30).optional().or(z.literal('')),
    /**
     * CPF ou CNPJ. Opcional, mas quando informado precisa ter 11 ou 14
     * dígitos — o Bling recusa qualquer outra coisa, e uma recusa do provedor
     * é uma mensagem pior do que uma validação local por campo.
     */
    cpfCnpj: z
      .string()
      .trim()
      .refine((valor) => valor === '' || [11, 14].includes(apenasDigitos(valor).length), {
        message: 'CPF deve ter 11 dígitos e CNPJ 14',
      })
      .optional()
      .or(z.literal('')),
    /**
     * Obrigatórios e explícitos. Nada é deduzido do documento: CNPJ não diz se
     * a empresa contribui ICMS, e um valor inventado aqui iria ao Bling, num
     * `PUT`, por cima da classificação real do contato.
     */
    tipo: contatoTipoSchema,
    indicadorIe: indicadorIeSchema,
    cep: z.string().trim().max(12).optional().or(z.literal('')),
    endereco: z.string().trim().max(120).optional().or(z.literal('')),
    numero: z.string().trim().max(20).optional().or(z.literal('')),
    bairro: z.string().trim().max(80).optional().or(z.literal('')),
    cidade: z.string().trim().max(80).optional().or(z.literal('')),
    uf: z.string().trim().length(2, 'UF deve ter 2 letras').optional().or(z.literal('')),
  });

export type ClienteRequest = z.infer<typeof clienteRequestSchema>;
export type ClienteRequestInput = z.input<typeof clienteRequestSchema>;

/**
 * Monta o corpo de `POST /api/clientes/update` a partir do formulário,
 * validado pelo mesmo schema que a rota executa.
 */
export function buildClienteRequest(input: ClienteRequestInput): ClienteRequest {
  return clienteRequestSchema.parse(input);
}
