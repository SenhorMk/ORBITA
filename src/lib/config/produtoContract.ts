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

/**
 * O ciclo de vida do produto NO ORBITA (migration 75), distinto da situação
 * do Bling: `ativo` é vendável; `inativo` espelha um produto inativo no Bling;
 * `arquivado` foi retirado da venda pelo ORBITA e continua no histórico dos
 * pedidos. Só `ativo` é candidato à venda.
 */
export const situacaoDoProdutoSchema = z.enum(['ativo', 'inativo', 'arquivado']);
export type SituacaoDoProduto = z.infer<typeof situacaoDoProdutoSchema>;

/**
 * A situação local que a sincronização grava a partir da do Bling. `E`
 * (excluído no Bling) não é decidido aqui — é o webhook de exclusão (PRE-004).
 * Um produto já arquivado no ORBITA continua arquivado: o banco não deixa
 * gravação comum desfazer o arquivamento.
 *
 * @param situacao - A situação crua do Bling.
 * @returns `ativo`/`inativo`, ou `undefined` para não gravar nada.
 */
export function situacaoLocalDaSituacaoBling(situacao: unknown): 'ativo' | 'inativo' | undefined {
  if (situacao === 'A') return 'ativo';
  if (situacao === 'I') return 'inativo';
  return undefined;
}

/** O vínculo do produto com o Bling, como o arquivamento precisa decidir. */
export type VinculoComBling =
  | { readonly _tag: 'Bling'; readonly blingId: string }
  /** Produto só do ORBITA: o único formato legítimo é o legado `LOCAL-<timestamp>`. */
  | { readonly _tag: 'SoLocal' }
  /** Nem id do Bling nem marca local reconhecida: pode haver conta remota que não se sabe qual. */
  | { readonly _tag: 'Ambiguo' };

/**
 * Classifica o `bling_id` gravado. Só um inteiro positivo é vínculo; só o
 * formato que o ORBITA já gerou para produto local (`LOCAL-${Date.now()}`) é
 * "sem Bling". Qualquer outra coisa — vazio, `temp_…`, texto — é ambígua: tratar
 * como local declararia sucesso ignorando uma possível conta remota.
 *
 * @param valor - O `bling_id` lido do banco.
 * @returns O vínculo classificado.
 */
export function classificarVinculoComBling(valor: unknown): VinculoComBling {
  const bruto = typeof valor === 'number' ? String(valor) : typeof valor === 'string' ? valor.trim() : '';
  if (/^[1-9]\d*$/u.test(bruto)) return { _tag: 'Bling', blingId: bruto };
  if (/^LOCAL-\d+$/u.test(bruto)) return { _tag: 'SoLocal' };
  return { _tag: 'Ambiguo' };
}

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

/**
 * O saldo que o formulário envia: só no cadastro ou quando a pessoa o alterou.
 *
 * O saldo é um balanço absoluto no Bling. Reenviar o valor lido ao abrir a
 * tela numa edição de nome ou preço desfaria as vendas feitas nesse
 * meio-tempo — no Bling e no espelho local.
 *
 * @param digitado - O texto do campo de estoque.
 * @param carregado - O estoque do produto quando a tela abriu (`undefined` no cadastro).
 * @param cadastro - `true` quando o produto ainda não existe.
 * @returns `{ estoque }` para espalhar no corpo, ou `{}` para não mexer no saldo.
 */
export function saldoParaEnvio(digitado: string, carregado: number | undefined, cadastro: boolean): { estoque?: number } {
  const saldo = parseInt(digitado, 10) || 0;
  return cadastro || saldo !== (carregado ?? 0) ? { estoque: saldo } : {};
}

/** O que aconteceu com o saldo pedido pelo formulário. */
export const desfechoDoSaldoSchema = z.enum(['nao_solicitado', 'aplicado', 'nao_confirmado']);

/**
 * Por que a gravação ficou indeterminada:
 *
 * - `bling_sem_confirmacao`: timeout, `5xx`, `429` ou exceção de rede — o
 *   Bling pode ter aplicado;
 * - `espelho_local_falhou`: o Bling confirmou, o ORBITA não espelhou.
 *
 * Nos dois casos reenviar não é a recuperação: a recuperação é sincronizar o
 * catálogo e conferir.
 */
export const motivoDaReconciliacaoSchema = z.enum(['bling_sem_confirmacao', 'espelho_local_falhou']);

/**
 * Corpo de `POST /api/produtos/update`, lido pelo modal com este mesmo
 * schema. `reconciliacao` é o estado estruturado que a tela usa para bloquear
 * a nova tentativa — a decisão não depende de comparar texto de erro.
 */
export const produtoUpdateResponseSchema = z.object({
  success: z.boolean(),
  avisos: z.array(z.string()).optional(),
  saldo: desfechoDoSaldoSchema.optional(),
  error: z.string().optional(),
  reconciliacao: z.object({
    motivo: motivoDaReconciliacaoSchema,
    blingId: z.string().nullable(),
  }).optional(),
});

export type ProdutoUpdateResponse = z.infer<typeof produtoUpdateResponseSchema>;
export type MotivoDaReconciliacao = z.infer<typeof motivoDaReconciliacaoSchema>;
