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
 * **Lista inteira descartada não é lista vazia.** Se o Bling devolveu itens e
 * nenhum deles casou com o schema, o formato mudou — e tratar isso como
 * "vazio" repetiria exatamente o defeito do ticket 31: uma lista vazia por
 * engano vira "a conta não tem a situação". Nesse caso a leitura falha.
 *
 * @returns a lista lida, ou `null` quando o corpo não é o envelope da v3 ou
 *   quando havia itens e nenhum foi reconhecido.
 */
function lerListagem<T>(body: unknown, schema: z.ZodType<T>): readonly T[] | null {
  const envelope = envelopeSchema.safeParse(body);
  if (!envelope.success) return null;

  const itens: T[] = [];
  for (const item of envelope.data.data) {
    const parsed = schema.safeParse(item);
    if (parsed.success) itens.push(parsed.data);
  }

  if (itens.length === 0 && envelope.data.data.length > 0) return null;
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
 * Descrições exatas conhecidas do módulo de pedidos de venda.
 *
 * O spec oficial exemplifica `descricao: "Pedidos de Venda"`; as variações aqui
 * cobrem singular e plural. Casar por igualdade é o critério mais forte, e por
 * isso vem primeiro — mas **não** é o único, porque esta lista é suposição a
 * partir de um exemplo, e a descrição real da conta pode ser outra.
 */
const DESCRICOES_EXATAS = new Set([
  'pedidos de venda',
  'pedido de venda',
  'pedidos de vendas',
  'pedidos venda',
]);

/**
 * Palavras que denunciam um módulo **diferente** do de pedidos de venda.
 *
 * "Devolução de Pedidos de Venda" contém "pedido" e "venda" e casaria por
 * substring; a lista existe para que o critério largo continue existindo sem
 * pegar o módulo errado.
 */
const TERMOS_DE_OUTRO_MODULO = ['devolucao', 'retorno', 'compra', 'proposta', 'orcamento', 'transferencia'];

/**
 * Acha o módulo de **pedidos de venda** entre os módulos da conta.
 *
 * Três critérios, do mais forte para o mais largo, porque os dois extremos
 * falham de jeitos diferentes e igualmente caros:
 *
 * 1. **descrição exata** conhecida;
 * 2. **descrição que contém "pedido" e "venda"** e nenhuma palavra de outro
 *    módulo — e só quando ela for **única**, porque duas candidatas significam
 *    que não dá para saber qual é;
 * 3. **`nome` igual a "vendas"**, o reserva.
 *
 * Casar só por substring escolhia a devolução quando ela vinha antes na lista.
 * Casar só por igualdade não acha uma conta cuja descrição fuja das quatro
 * formas conhecidas — e aí o cancelamento para de funcionar por inteiro, que é
 * pior do que escolher errado, porque é o caminho da compensação.
 */
export function encontrarModuloDePedidosDeVenda(
  modulos: readonly ModuloSistema[],
): ModuloSistema | null {
  const porDescricaoExata = modulos.find((modulo) =>
    DESCRICOES_EXATAS.has(normalizar(modulo.descricao ?? '')),
  );
  if (porDescricaoExata) return porDescricaoExata;

  const candidatas = modulos.filter((modulo) => {
    const descricao = normalizar(modulo.descricao ?? '');
    if (!descricao.includes('pedido') || !descricao.includes('venda')) return false;
    return !TERMOS_DE_OUTRO_MODULO.some((termo) => descricao.includes(termo));
  });
  // Ambiguidade não se resolve por ordem de lista: com duas candidatas, a
  // escolha seria arbitrária, e errar aqui aplica ao pedido a situação de outro
  // módulo. Melhor devolver nada e deixar a mensagem dizer isso.
  if (candidatas.length === 1) return candidatas[0] ?? null;

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
