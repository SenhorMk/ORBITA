import { normalizar, type ItemDoCatalogo } from './catalogo';

/**
 * A última barreira antes do envio: o texto do modelo só sai se não afirmar
 * preço que não veio do ERP, não pedir dado sensível, não trouxer link e não
 * prometer ação executada. Falhar aqui não deixa a pessoa sem resposta: o
 * worker escala para a equipe pelo caminho que já existe.
 */
export type Problema = 'vazio' | 'longo' | 'link' | 'dado_sensivel' | 'preco_sem_fonte' | 'acao_afirmada' | 'preco_de_produto_sem_cadastro';

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
function atribuiPrecoASemCadastro(texto: string, nomesSemCadastro: readonly string[]): boolean {
  if (nomesSemCadastro.length === 0) return false;
  const nomes = nomesSemCadastro.map(normalizar);
  return normalizar(texto).split(/[.!?;\n]+/u)
    .some((frase) => PRECO_OU_ESTOQUE.test(frase) && nomes.some((n) => frase.includes(n)));
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
  return null;
}
