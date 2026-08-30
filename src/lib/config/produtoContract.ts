import { z } from 'zod';

/**
 * Contrato único do corpo de `POST /api/produtos/update`.
 *
 * Terceiro da série (`blingCredentialsContract`, `manualOrderContract`), pelo
 * mesmo motivo: a rota recebia o corpo com `body as ProdutoInputBody` — um
 * cast, não uma validação — e o `ProductDetailModal` montava
 * `Partial<Produto> & {...}` por conta própria. Dois lados coerentes consigo
 * mesmos e livres para divergir, que é o arranjo que produziu os bugs dos
 * tickets 26, 27 e 28.
 */

/**
 * Enums do produto no Bling, transcritos do OpenAPI oficial
 * (`developer.bling.com.br/build/assets/openapi-*.json`):
 *
 * - `tipo`: `S` Serviço, `P` Produto, `N` Serviço 06 21 22
 * - `situacao`: `A` Ativo, `I` Inativo
 * - `formato`: `S` Simples, `V` Com variações, `E` Com composição
 *
 * Obrigatórios em `POST /produtos`: `nome`, `tipo`, `situacao`, `formato`.
 */
export const produtoTipoSchema = z.enum(['S', 'P', 'N']);
export const produtoSituacaoSchema = z.enum(['A', 'I']);
export const produtoFormatoSchema = z.enum(['S', 'V', 'E']);

export type ProdutoTipo = z.infer<typeof produtoTipoSchema>;
export type ProdutoSituacao = z.infer<typeof produtoSituacaoSchema>;
export type ProdutoFormato = z.infer<typeof produtoFormatoSchema>;

export const produtoRequestSchema = z.object({
  /** UUID local quando é edição; ausente quando é cadastro novo. */
  id: z.string().uuid().optional(),
  /**
   * Id do produto no Bling, quando já sincronizado. Só um id numérico do
   * provedor é aceito — nada de `LOCAL-...` ou outro rótulo local.
   */
  blingId: z.string().regex(/^\d+$/u, 'blingId deve ser o id numérico do Bling').optional(),
  nome: z.string().trim().min(1, 'O nome do produto é obrigatório').max(120),
  /**
   * SKU. Opcional no Bling e **opcional aqui**: quando o usuário não informa,
   * nada é enviado. A versão anterior inventava `ORB-<timestamp>` no adapter e
   * `BLING-<bling_id>` no modal — dois caminhos independentes gravando no ERP
   * um código que o usuário nunca escolheu, e que o registro local não
   * guardava, fazendo a busca seguinte falhar e duplicar o produto.
   */
  codigo: z.string().trim().min(1).max(60).optional(),
  preco: z.number().nonnegative('Preço não pode ser negativo'),
  /**
   * Saldo desejado. Não vai no payload do produto — em `POST /produtos` o campo
   * `estoque` é um **objeto** (`minimo`, `maximo`, `localizacao`) e o saldo é
   * `readOnly`. O saldo entra por `POST /estoques`, com operação de balanço.
   */
  estoque: z.number().int().nonnegative('Estoque não pode ser negativo').optional(),
  tipo: produtoTipoSchema.default('P'),
  situacao: produtoSituacaoSchema.default('A'),
  formato: produtoFormatoSchema.default('S'),
  unidade: z.string().trim().min(1).max(6).default('UN'),
  categoriaId: z.string().uuid().optional(),
});

export type ProdutoRequest = z.infer<typeof produtoRequestSchema>;
export type ProdutoRequestInput = z.input<typeof produtoRequestSchema>;

/**
 * Monta o corpo de `POST /api/produtos/update` a partir do formulário.
 * O retorno é validado pelo mesmo schema que a rota executa, então uma
 * divergência de forma falha aqui, antes da requisição.
 */
export function buildProdutoRequest(input: ProdutoRequestInput): ProdutoRequest {
  return produtoRequestSchema.parse(input);
}
