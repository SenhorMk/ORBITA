import { normalizar, termos, type ItemDoCatalogo } from './catalogo';

/**
 * A última barreira antes do envio: o texto do modelo só sai se não afirmar
 * preço que não veio do ERP, não pedir dado sensível, não trouxer link e não
 * prometer ação executada. Falhar aqui não deixa a pessoa sem resposta: o
 * worker escala para a equipe pelo caminho que já existe.
 */
export type Problema = 'vazio' | 'longo' | 'link' | 'dado_sensivel' | 'preco_sem_fonte' | 'acao_afirmada' | 'preco_de_produto_sem_cadastro' | 'preco_sem_produto'
  | 'promessa_de_envio' | 'indisponivel_como_disponivel' | 'beneficio_inventado';

const LINK = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|net|org|br|io|app)(?:\.br)?\b/iu;
const DADO_SENSIVEL = /\b(?:cpf|rg|senha|cart[aã]o|cvv|c[oó]digo de seguran[cç]a|n[uú]mero do cart[aã]o|pix copia)\b/iu;
const ACAO_AFIRMADA = /\b(?:j[aá] (?:cancelei|estornei|reembolsei|enviei|despachei|alterei|registrei)|pedido (?:foi )?(?:cancelado|estornado|reembolsado|enviado|despachado)|reembolso (?:foi )?(?:feito|aprovado))\b/iu;
const PRECO = /R\$\s?(\d{1,3}(?:\.\d{3})*|\d+)(?:,(\d{2}))?/giu;
const DISPONIVEL = /\bdisponive(?:l|is)\b|\bem estoque\b/u;
const NEGACAO = /\b(?:nao|sem|ainda|indisponive(?:l|is)|desconhecid[oa]s?|nenhum[a]?)\b/u;
/** Estoque não é prazo: nada de pronta-entrega, envio imediato, prazo de entrega ou reserva sem política confirmada. */
const PROMESSA_DE_ENVIO = /\bpront[oa]s? (?:para|pra) (?:envio|entrega|despacho|enviar)\b|\bpronta[ -]entrega\b|\b(?:envio|entrega|despacho) imediat[oa]\b|\b(?:enviamos|despachamos|postamos|entregamos) (?:hoje|amanha|no mesmo dia)\b|\b(?:chega|chegara|chegam|entregue) em \d|\bprazo de (?:envio|entrega) (?:e|de) \d|\bgarant(?:imos|ida|ido) (?:a )?(?:disponibilidade|entrega|envio)\b|\breservad[oa]s? (?:para|pra) (?:voce|vc)\b/u;
/** Propriedade ou benefício que nenhuma fonte da marca afirma (saúde, garantia de efeito). */
const BENEFICIO = /\b(?:cura|curar|curam|trata|tratar|tratamento|alivia|aliviar|ansiedade|depress\w*|insonia|doenca\w*|remedio\w*|terapeutic\w*|medicinal|garante|garantid[oa]s?|comprovad[oa]s?|100 ?%)\b/u;

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

/**
 * O trecho cita o nome real do item: ao menos metade dos termos do nome e,
 * havendo, um termo que só esse item tem no catálogo ("kuripe" sozinho não
 * distingue "Kuripe Floral" de "Kuripe Grande Verde").
 */
function citaItem(trecho: string, item: ItemDoCatalogo, catalogo: readonly ItemDoCatalogo[]): boolean {
  const doTrecho = new Set(termos(trecho));
  const doNome = termos(item.nome);
  if (doNome.length === 0 || doNome.filter((t) => doTrecho.has(t)).length < Math.ceil(doNome.length / 2)) return false;
  const dosOutros = new Set(catalogo.filter((o) => o !== item).flatMap((o) => termos(o.nome)));
  const proprios = doNome.filter((t) => !dosOutros.has(t));
  return proprios.length === 0 || proprios.some((t) => doTrecho.has(t));
}

/**
 * Preço, ou disponibilidade afirmada, numa frase que cita um produto sem
 * cadastro no ERP e nenhum item real do catálogo: atribuição inventada.
 */
function atribuiPrecoASemCadastro(texto: string, nomesSemCadastro: readonly string[], catalogo: readonly ItemDoCatalogo[]): boolean {
  if (nomesSemCadastro.length === 0) return false;
  return frases(texto).some((frase) => {
    if (!nomesSemCadastro.some((n) => citaProduto(frase, n))) return false;
    if (catalogo.some((item) => citaItem(frase, item, catalogo))) return false;
    return /r\$/u.test(frase) || (DISPONIVEL.test(frase) && !NEGACAO.test(frase));
  });
}

/**
 * Todo preço citado precisa vir junto do nome real de um item do ERP com
 * esse valor, na mesma frase ou na anterior: o modelo não pode renomear um
 * produto nem pendurar o valor num nome inventado.
 */
function precoSemProduto(texto: string, catalogo: readonly ItemDoCatalogo[]): boolean {
  const todas = frases(texto);
  return todas.some((frase, i) => [...frase.matchAll(PRECO)].some((m) => {
    const valor = Number(`${m[1].replace(/\./gu, '')}.${m[2] ?? '00'}`).toFixed(2);
    const trecho = `${todas[i - 1] ?? ''} ${frase}`;
    return !catalogo.some((item) => item.preco !== null && item.preco.toFixed(2) === valor && citaItem(trecho, item, catalogo));
  }));
}

/** Item sem estoque apresentado como disponível (afirmação, sem negação na frase). */
function indisponivelComoDisponivel(texto: string, catalogo: readonly ItemDoCatalogo[]): boolean {
  const semEstoque = catalogo.filter((i) => !i.disponivel);
  return frases(texto).some((frase) => DISPONIVEL.test(frase) && !NEGACAO.test(frase)
    && semEstoque.some((item) => citaItem(frase, item, catalogo)));
}

const afirmaSemNegar = (texto: string, padrao: RegExp) => frases(texto).some((f) => padrao.test(f) && !NEGACAO.test(f));

export function validarResposta(texto: string, catalogoNoContexto: readonly ItemDoCatalogo[],
  nomesSemCadastro: readonly string[] = []): Problema | null {
  const limpo = texto.trim();
  if (!limpo) return 'vazio';
  if (limpo.length > 900) return 'longo';
  if (LINK.test(limpo)) return 'link';
  if (DADO_SENSIVEL.test(limpo)) return 'dado_sensivel';
  if (ACAO_AFIRMADA.test(limpo)) return 'acao_afirmada';
  const permitidos = new Set(catalogoNoContexto.flatMap((i) => (i.preco === null ? [] : [i.preco.toFixed(2)])));
  if (valoresCitados(limpo).some((v) => !permitidos.has(v.toFixed(2)))) return 'preco_sem_fonte';
  if (atribuiPrecoASemCadastro(limpo, nomesSemCadastro, catalogoNoContexto)) return 'preco_de_produto_sem_cadastro';
  if (precoSemProduto(limpo, catalogoNoContexto)) return 'preco_sem_produto';
  if (afirmaSemNegar(limpo, PROMESSA_DE_ENVIO)) return 'promessa_de_envio';
  if (indisponivelComoDisponivel(limpo, catalogoNoContexto)) return 'indisponivel_como_disponivel';
  if (afirmaSemNegar(limpo, BENEFICIO)) return 'beneficio_inventado';
  return null;
}
