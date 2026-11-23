import { normalizar, termos, type ItemDoCatalogo } from './catalogo';

/**
 * A última barreira antes do envio: o texto do modelo só sai se não afirmar
 * preço que não veio do ERP, não pedir dado sensível, não trouxer link e não
 * prometer ação executada. Falhar aqui não deixa a pessoa sem resposta: o
 * worker escala para a equipe pelo caminho que já existe.
 */
export type Problema = 'vazio' | 'longo' | 'link' | 'dado_sensivel' | 'preco_sem_fonte' | 'acao_afirmada' | 'preco_de_produto_sem_cadastro' | 'preco_sem_produto';

const LINK = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|net|org|br|io|app)(?:\.br)?\b/iu;
const DADO_SENSIVEL = /\b(?:cpf|rg|senha|cart[aã]o|cvv|c[oó]digo de seguran[cç]a|n[uú]mero do cart[aã]o|pix copia)\b/iu;
const ACAO_AFIRMADA = /\b(?:j[aá] (?:cancelei|estornei|reembolsei|enviei|despachei|alterei|registrei)|pedido (?:foi )?(?:cancelado|estornado|reembolsado|enviado|despachado)|reembolso (?:foi )?(?:feito|aprovado))\b/iu;
const PRECO = /R\$\s?(\d{1,3}(?:\.\d{3})*|\d+)(?:,(\d{2}))?/giu;
const PRECO_OU_ESTOQUE = /r\$|\bdisponive(?:l|is)\b|\bem estoque\b/u;

function valoresCitados(texto: string): number[] {
  return [...texto.matchAll(PRECO)].map((m) => Number(`${m[1].replace(/\./gu, '')}.${m[2] ?? '00'}`));
}

/**
 * Preço ou disponibilidade na mesma frase que um produto sem cadastro no ERP
 * (ex.: uma linha descrita pela marca) é atribuição inventada, mesmo que o
 * valor exista para outro item do catálogo.
 */
const frases = (texto: string) => normalizar(texto).split(/[.!?;\n]+/u);

/** O nome completo ou "portal" + a palavra própria da linha ("portal da harmonia"). */
function citaProduto(frase: string, nome: string): boolean {
  const n = normalizar(nome);
  const propria = n.split(/\s+/u).at(-1) ?? n;
  return frase.includes(n) || (frase.includes('portal') && frase.includes(propria));
}

function atribuiPrecoASemCadastro(texto: string, nomesSemCadastro: readonly string[]): boolean {
  if (nomesSemCadastro.length === 0) return false;
  return frases(texto).some((frase) => PRECO_OU_ESTOQUE.test(frase) && nomesSemCadastro.some((n) => citaProduto(frase, n)));
}

/**
 * Todo preço citado precisa estar na mesma frase que o nome real de um item
 * do ERP com esse preço (ao menos metade dos termos do nome): o modelo não
 * pode renomear um produto nem pendurar o valor num nome inventado.
 */
function precoSemProduto(texto: string, catalogo: readonly ItemDoCatalogo[]): boolean {
  return frases(texto).some((frase) => [...frase.matchAll(PRECO)].some((m) => {
    const valor = Number(`${m[1].replace(/\./gu, '')}.${m[2] ?? '00'}`).toFixed(2);
    const daFrase = new Set(termos(frase));
    return !catalogo.some((item) => {
      if (item.preco.toFixed(2) !== valor) return false;
      const doNome = termos(item.nome);
      const presentes = doNome.filter((t) => daFrase.has(t)).length;
      return doNome.length > 0 && presentes >= Math.ceil(doNome.length / 2);
    });
  }));
}

export function validarResposta(texto: string, catalogoNoContexto: readonly ItemDoCatalogo[],
  nomesSemCadastro: readonly string[] = []): Problema | null {
  const limpo = texto.trim();
  if (!limpo) return 'vazio';
  if (limpo.length > 900) return 'longo';
  if (LINK.test(limpo)) return 'link';
  if (DADO_SENSIVEL.test(limpo)) return 'dado_sensivel';
  if (ACAO_AFIRMADA.test(limpo)) return 'acao_afirmada';
  const permitidos = new Set(catalogoNoContexto.map((i) => i.preco.toFixed(2)));
  if (valoresCitados(limpo).some((v) => !permitidos.has(v.toFixed(2)))) return 'preco_sem_fonte';
  if (atribuiPrecoASemCadastro(limpo, nomesSemCadastro)) return 'preco_de_produto_sem_cadastro';
  if (precoSemProduto(limpo, catalogoNoContexto)) return 'preco_sem_produto';
  return null;
}
