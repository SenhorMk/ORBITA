import { z } from 'zod';

/**
 * Contrato dos recursos de **situações** da API v3 do Bling.
 *
 * A autoridade deste arquivo é o documento OpenAPI **oficial** publicado pelo
 * Bling e carregado pelo próprio portal de referência:
 *
 *   https://developer.bling.com.br/build/assets/openapi-BvBfsn8J.json
 *
 * Existe porque a descoberta da situação "Cancelado" usava a rota errada e
 * devolvia lista vazia em **qualquer** conta (Ticket 31). São dois recursos
 * distintos, e o código antigo tratava como se fosse um só:
 *
 * | Rota | Devolve |
 * |---|---|
 * | `GET /situacoes/modulos` | os **módulos**: `{ id, nome, descricao, criarSituacoes }` |
 * | `GET /situacoes/modulos/{idModuloSistema}` | as **situações** daquele módulo: `{ id, nome, idHerdado?, cor? }` |
 *
 * A lista de módulos **não** carrega as situações dentro de si. Procurar um
 * campo `situacoes` na resposta da primeira rota não acha nada — nunca achou.
 *
 * ## Os ids são por conta
 *
 * `idModuloSistema` é `integer` com exemplo `12345678` no spec: é identificador
 * da conta, não constante da API. O `9` que estava fixo no código é o exemplo
 * de **`SituacoesDTO.id`** — id de *situação*, de outro schema. Fixar qualquer
 * um dos dois inventa um valor, então o módulo é descoberto pelo nome.
 */

/** Um módulo do sistema, como `GET /situacoes/modulos` o descreve. */
export const moduloSistemaSchema = z.object({
  id: z.number().int().positive(),
  nome: z.string().optional(),
  descricao: z.string().optional(),
});

/** Uma situação, como `GET /situacoes/modulos/{id}` a descreve. */
export const situacaoSchema = z.object({
  id: z.number().int().positive(),
  nome: z.string().min(1),
});

export type ModuloSistema = z.infer<typeof moduloSistemaSchema>;
export type Situacao = z.infer<typeof situacaoSchema>;

/** Envelope `{ data: [...] }` que a v3 usa em toda listagem. */
const envelopeSchema = z.object({ data: z.array(z.unknown()) });

/**
 * Lê uma listagem da v3 descartando **apenas** os itens que não servem.
 *
 * Defensivo de propósito: um item novo ou malformado no meio da lista não pode
 * derrubar a descoberta inteira. O que não dá para descartar em silêncio é a
 * resposta não ser a listagem esperada — aí o chamador precisa saber, e a
 * distinção entre `null` (formato inesperado) e `[]` (listagem vazia de
 * verdade) é o que permite mensagens diferentes.
 *
 * @returns a lista lida, ou `null` quando o corpo não é o envelope da v3.
 */
function lerListagem<T>(body: unknown, schema: z.ZodType<T>): readonly T[] | null {
  const envelope = envelopeSchema.safeParse(body);
  if (!envelope.success) return null;

  const itens: T[] = [];
  for (const item of envelope.data.data) {
    const parsed = schema.safeParse(item);
    if (parsed.success) itens.push(parsed.data);
  }
  return itens;
}

/** Lê `GET /situacoes/modulos`. `null` quando o corpo não é a listagem esperada. */
export function lerModulos(body: unknown): readonly ModuloSistema[] | null {
  return lerListagem(body, moduloSistemaSchema);
}

/** Lê `GET /situacoes/modulos/{id}`. `null` quando o corpo não é a listagem esperada. */
export function lerSituacoes(body: unknown): readonly Situacao[] | null {
  return lerListagem(body, situacaoSchema);
}

/** Minúsculas e sem acento, para comparar rótulo digitado por humano. */
function normalizar(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
    .toLowerCase();
}

/**
 * Acha o módulo de **pedidos de venda** entre os módulos da conta.
 *
 * O spec oficial exemplifica esse módulo como `nome: "Vendas"`,
 * `descricao: "Pedidos de Venda"`. A descrição é o critério forte — exige as
 * duas palavras, para não casar com "Pedidos de compra". O nome é o reserva.
 */
export function encontrarModuloDePedidosDeVenda(
  modulos: readonly ModuloSistema[],
): ModuloSistema | null {
  const porDescricao = modulos.find((modulo) => {
    const descricao = normalizar(modulo.descricao ?? '');
    return descricao.includes('pedido') && descricao.includes('venda');
  });
  if (porDescricao) return porDescricao;

  return modulos.find((modulo) => normalizar(modulo.nome ?? '') === 'vendas') ?? null;
}

/** Nomes que uma conta pode dar à situação de cancelamento. */
const NOMES_DE_CANCELAMENTO = ['cancelado', 'cancelada'] as const;

/** Acha a situação de cancelamento pelo nome, tolerando acento e caixa. */
export function encontrarSituacaoDeCancelamento(
  situacoes: readonly Situacao[],
): Situacao | null {
  return (
    situacoes.find((situacao) =>
      (NOMES_DE_CANCELAMENTO as readonly string[]).includes(normalizar(situacao.nome)),
    ) ?? null
  );
}
