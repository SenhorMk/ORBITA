/**
 * Ranking determinístico de produtos para o Assistente ORBITA (sem IA).
 *
 * O modelo só copia a referência que a pessoa escreveu ("rapé de cravo"); quem
 * decide quais produtos ela pode estar citando é este algoritmo, sobre o
 * catálogo escopado da organização:
 * - normaliza acentos, caixa e plurais simples e ignora palavras vazias;
 * - cada palavra da referência casa com o nome, o SKU ou a categoria do
 *   produto por igualdade, prefixo ou erro de digitação pequeno;
 * - palavras raras no catálogo pesam mais (IDF): "cravo" diferencia, "rapé" não;
 * - a pontuação é a cobertura ponderada da referência, com bônus para SKU exato.
 */

/** Produto do catálogo como o ranking enxerga. */
export interface ProdutoRanqueavel {
  readonly id: string;
  readonly nome: string;
  readonly codigo: string | null;
  readonly categoria?: string | null;
}

/** Produto pontuado; `exato` quando SKU ou nome são iguais à referência. */
export interface Candidato<T extends ProdutoRanqueavel> {
  readonly produto: T;
  readonly pontuacao: number;
  readonly exato: boolean;
}

/** Resultado do ranking: nada parecido, um produto inequívoco ou uma lista para escolher. */
export type DecisaoDoRanking<T extends ProdutoRanqueavel> =
  | { readonly tipo: 'nenhum' }
  | { readonly tipo: 'unico'; readonly candidato: Candidato<T> }
  | { readonly tipo: 'escolher'; readonly candidatos: readonly Candidato<T>[]; readonly total: number };

const PARADAS = new Set([
  'de', 'do', 'da', 'dos', 'das', 'o', 'a', 'os', 'as', 'e', 'em', 'no', 'na', 'para', 'pra', 'com', 'um', 'uma',
  'produto', 'produtos', 'item', 'itens', 'sku', 'nome', 'estoque', 'saldo', 'codigo', 'ml',
]);

/** Sem acentos e em minúsculas. */
export function normalizarTexto(texto: string): string {
  return texto.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('pt-BR');
}

/** Plural simples do português: "sabores" → "sabor", "kuripes" → "kuripe", "rapés" → "rape". */
function singular(palavra: string): string {
  if (palavra.length > 4 && /[rzl]es$/u.test(palavra)) return palavra.slice(0, -2);
  if (palavra.length > 3 && palavra.endsWith('s') && !palavra.endsWith('ss') && !/\d/u.test(palavra)) return palavra.slice(0, -1);
  return palavra;
}

/** Palavras úteis de um texto, normalizadas e no singular. */
export function palavras(texto: string): string[] {
  return normalizarTexto(texto).split(/[^a-z0-9]+/u)
    .filter((p) => p.length >= 2 && !PARADAS.has(p))
    .map(singular);
}

function compacto(texto: string): string {
  return normalizarTexto(texto).replace(/[^a-z0-9]/gu, '');
}

/** Distância de edição com corte: devolve `limite + 1` assim que passar do limite. */
export function distancia(a: string, b: string, limite: number): number {
  if (Math.abs(a.length - b.length) > limite) return limite + 1;
  let anterior = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const atual = [i];
    let menor = i;
    for (let j = 1; j <= b.length; j++) {
      const custo = a[i - 1] === b[j - 1] ? 0 : 1;
      atual[j] = Math.min(anterior[j] + 1, atual[j - 1] + 1, anterior[j - 1] + custo);
      menor = Math.min(menor, atual[j]);
    }
    if (menor > limite) return limite + 1;
    anterior = atual;
  }
  return anterior[b.length];
}

/** Quanto uma palavra da referência casa com uma palavra do produto (0 a 1). */
function casamento(buscada: string, doProduto: string): number {
  if (buscada === doProduto) return 1;
  const menor = Math.min(buscada.length, doProduto.length);
  if (menor >= 3 && (doProduto.startsWith(buscada) || buscada.startsWith(doProduto))) return 0.8;
  const limite = buscada.length >= 7 ? 2 : buscada.length >= 4 ? 1 : 0;
  // Erro de digitação vale menos: sozinho, nunca torna um produto inequívoco.
  if (limite > 0 && distancia(buscada, doProduto, limite) <= limite) return 0.6;
  return 0;
}

function melhorCasamento(buscada: string, doProduto: readonly string[]): number {
  let melhor = 0;
  for (const p of doProduto) {
    melhor = Math.max(melhor, casamento(buscada, p));
    if (melhor === 1) break;
  }
  return melhor;
}

const COBERTURA_MINIMA = 0.5;
const LIMITE_PADRAO = 5;

/**
 * Pontua o catálogo contra a referência e devolve, do mais provável para o
 * menos provável, todos os parecidos (ou só os `limite` primeiros). Só entram produtos que cobrem ao menos metade do peso
 * da referência; SKU igual (ignorando pontuação) entra sempre, no topo.
 */
export function ranquearProdutos<T extends ProdutoRanqueavel>(
  referencia: string, catalogo: readonly T[], limite = Number.POSITIVE_INFINITY,
): Candidato<T>[] {
  const buscadas = [...new Set(palavras(referencia))];
  const refCompacta = compacto(referencia);
  const refNome = normalizarTexto(referencia).trim();
  const tokensDe = catalogo.map((p) => [...new Set([
    ...palavras(p.nome), ...palavras(p.codigo ?? ''), ...palavras(p.categoria ?? ''),
  ])]);
  const n = catalogo.length;
  const pesos = buscadas.map((b) => {
    const df = tokensDe.filter((t) => melhorCasamento(b, t) >= 0.6).length;
    return Math.log(1 + n / Math.max(df, 1));
  });
  const pesoTotal = pesos.reduce((s, p) => s + p, 0);
  const candidatos: Candidato<T>[] = [];
  catalogo.forEach((produto, i) => {
    const skuCompacto = produto.codigo ? compacto(produto.codigo) : '';
    const skuExato = skuCompacto !== '' && skuCompacto === refCompacta;
    const nomeExato = normalizarTexto(produto.nome).trim() === refNome;
    let cobertura = 0;
    if (pesoTotal > 0) {
      buscadas.forEach((b, k) => { cobertura += pesos[k] * melhorCasamento(b, tokensDe[i]); });
      cobertura /= pesoTotal;
    }
    const skuContem = refCompacta.length >= 4 && skuCompacto.includes(refCompacta);
    const pontuacao = (skuExato ? 2 : 0) + (nomeExato ? 1.5 : 0) + cobertura + (skuContem ? 0.3 : 0);
    if (skuExato || nomeExato || cobertura >= COBERTURA_MINIMA) {
      candidatos.push({ produto, pontuacao: Math.round(pontuacao * 1000) / 1000, exato: skuExato || nomeExato });
    }
  });
  return candidatos
    .sort((a, b) => b.pontuacao - a.pontuacao || a.produto.nome.length - b.produto.nome.length
      || a.produto.nome.localeCompare(b.produto.nome, 'pt-BR'))
    .slice(0, limite);
}

/**
 * Decide se dá para seguir com um produto ou se é preciso perguntar.
 * Único só quando não há dúvida: SKU/nome exato sem empate, ou um só produto
 * que cobre toda a referência e se destaca do segundo.
 */
export function decidirProduto<T extends ProdutoRanqueavel>(
  candidatos: readonly Candidato<T>[], limite = LIMITE_PADRAO,
): DecisaoDoRanking<T> {
  if (candidatos.length === 0) return { tipo: 'nenhum' };
  const [primeiro, segundo] = candidatos;
  const exatos = candidatos.filter((c) => c.exato);
  if (exatos.length === 1 && exatos[0] === primeiro) return { tipo: 'unico', candidato: primeiro };
  const completo = primeiro.pontuacao >= 0.99;
  if (completo && (!segundo || segundo.pontuacao < 0.75 * primeiro.pontuacao)) return { tipo: 'unico', candidato: primeiro };
  return { tipo: 'escolher', candidatos: candidatos.slice(0, limite), total: candidatos.length };
}
