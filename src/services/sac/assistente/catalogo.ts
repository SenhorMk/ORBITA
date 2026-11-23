import type { ConhecimentoDaOrganizacao } from './conhecimento';

/**
 * O catálogo verificado que o assistente pode citar: espelho do ERP (Bling),
 * somente leitura, escopado pela organização do worker. Nada aqui vem da
 * mensagem do cliente.
 */
export interface ItemDoCatalogo {
  readonly nome: string;
  readonly categoria: string | null;
  /** Preço do ERP em reais, com duas casas. */
  readonly preco: number;
  readonly disponivel: boolean;
}

/** Linha bruta de `produtos` (+ categoria) como o Supabase devolve. */
export interface LinhaDeProduto {
  readonly nome: string | null;
  readonly preco: number | string | null;
  readonly estoque: number | null;
  readonly estoque_reservado: number | null;
  readonly situacao: string | null;
  readonly arquivado_em: string | null;
  readonly categoria?: { readonly descricao: string | null } | null;
}

/** Leitor mínimo do banco: a mesma forma do cliente Supabase do worker. */
export interface LeitorDeProdutos {
  lerProdutos(organizacaoId: string): Promise<readonly LinhaDeProduto[]>;
}

export function normalizar(texto: string): string {
  return texto.normalize('NFD').replace(/[̀-ͯ]/gu, '').toLowerCase();
}

/** Só o que é vendável ao público: ativo, não arquivado, com preço, fora dos ocultos. */
export function montarCatalogo(linhas: readonly LinhaDeProduto[], conhecimento: ConhecimentoDaOrganizacao): ItemDoCatalogo[] {
  const itens: ItemDoCatalogo[] = [];
  for (const linha of linhas) {
    const nome = linha.nome?.trim();
    const preco = Number(linha.preco);
    if (!nome || linha.arquivado_em || (linha.situacao ?? 'ativo') !== 'ativo') continue;
    if (!Number.isFinite(preco) || preco <= 0) continue;
    if (conhecimento.produtosOcultos.some((r) => r.test(nome))) continue;
    const livre = (linha.estoque ?? 0) - (linha.estoque_reservado ?? 0);
    itens.push({ nome, categoria: linha.categoria?.descricao?.trim() || null, preco: Math.round(preco * 100) / 100, disponivel: livre > 0 });
  }
  return itens;
}

const VAZIAS = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'o', 'a', 'os', 'as', 'um', 'uma', 'para', 'pra', 'com',
  'que', 'qual', 'quais', 'quanto', 'quanta', 'custa', 'custam', 'preco', 'precos', 'valor', 'voce', 'vc', 'tem',
  'vende', 'vendem', 'linha', 'linhas', 'recomenda', 'oi', 'ola', 'bom', 'boa', 'dia', 'tarde', 'noite', 'queria',
  'quero', 'saber', 'me', 'meu', 'minha', 'produto', 'produtos', 'esse', 'essa', 'isso', 'mais', 'no', 'na', 'em']);

/** Tokens úteis, com singular simples ("defumadores" → "defumador"). */
export function termos(texto: string): string[] {
  return normalizar(texto).split(/[^a-z0-9]+/u).filter((t) => t.length >= 3 && !VAZIAS.has(t))
    .map((t) => (t.endsWith('es') && t.length > 5 ? t.slice(0, -2) : t.endsWith('s') && t.length > 4 ? t.slice(0, -1) : t));
}

/**
 * Recuperação simples, sem embeddings: os itens cujo nome ou categoria
 * compartilham termos com a mensagem atual. Sem termo em comum, nenhum item:
 * o assistente vê só as categorias e pergunta o que a pessoa procura.
 */
export function selecionarRelevantes(itens: readonly ItemDoCatalogo[], mensagem: string, limite = 12): ItemDoCatalogo[] {
  const buscados = new Set(termos(mensagem));
  if (buscados.size === 0) return [];
  return itens.map((item) => {
    const doItem = new Set(termos(`${item.nome} ${item.categoria ?? ''}`));
    const pontos = [...buscados].filter((t) => doItem.has(t) || [...doItem].some((d) => d.startsWith(t) || t.startsWith(d))).length;
    return { item, pontos };
  }).filter((x) => x.pontos > 0)
    .sort((a, b) => b.pontos - a.pontos || Number(b.item.disponivel) - Number(a.item.disponivel) || a.item.nome.localeCompare(b.item.nome))
    .slice(0, limite).map((x) => x.item);
}

export const formatarPreco = (valor: number) => `R$ ${valor.toFixed(2).replace('.', ',')}`;

/** O bloco de catálogo enviado ao modelo: mínimo, sem estoque exato nem ids. */
export function descreverCatalogo(itens: readonly ItemDoCatalogo[], relevantes: readonly ItemDoCatalogo[]): string {
  const categorias = [...new Set(itens.map((i) => i.categoria).filter((c): c is string => c !== null))].sort();
  const linhas = relevantes.map((i) => `- ${i.nome} | ${i.categoria ?? 'sem categoria'} | ${formatarPreco(i.preco)} | ${i.disponivel ? 'disponível' : 'sem estoque no momento'}`);
  return [
    `Categorias do catálogo: ${categorias.length ? categorias.join(', ') : 'não informadas'}.`,
    linhas.length ? `Produtos relacionados à mensagem (preço do ERP):\n${linhas.join('\n')}` : 'Nenhum produto do catálogo corresponde à mensagem atual.',
    'Não há descrições, indicações ou modo de uso aprovados para estes produtos.',
  ].join('\n');
}

/** Cache curto do catálogo por organização: o ERP muda devagar, a conversa não espera. */
export function criarCatalogoComCache(leitor: LeitorDeProdutos, conhecimento: ConhecimentoDaOrganizacao, ttlMs = 60_000) {
  let guardado: { readonly em: number; readonly itens: ItemDoCatalogo[] } | null = null;
  return async (): Promise<ItemDoCatalogo[]> => {
    if (guardado && Date.now() - guardado.em < ttlMs) return guardado.itens;
    const itens = montarCatalogo(await leitor.lerProdutos(conhecimento.organizacaoId), conhecimento);
    guardado = { em: Date.now(), itens };
    return itens;
  };
}
