import { CONHECIMENTO_PORTAL_DO_HAUX } from './organizacoes/portalDoHaux';

/**
 * O que o assistente sabe de cada organização, separado das regras globais.
 *
 * Regras globais (comportamento, segurança, limites) ficam em
 * `respostaAutomaticaHaux.ts`/`docs/ai/ASSISTENTE_ORBITA.md`. Cada organização
 * tem o seu arquivo em `organizacoes/` (identidade, linhas de produto,
 * políticas com situação e fonte). Política que não está `confirmada` nunca
 * chega ao modelo como fato. Preço e estoque nunca ficam aqui: vêm do ERP.
 */

export type SituacaoDaPolitica = 'confirmada' | 'pendente' | 'indisponivel';

export interface Politica {
  readonly tema: string;
  readonly situacao: SituacaoDaPolitica;
  /** Texto aprovado; só existe quando `situacao === 'confirmada'`. */
  readonly texto?: string;
  /** De onde veio a confirmação (documento, decisão registrada). */
  readonly fonte?: string;
}

/** Linha de produto descrita pela marca (não é item do ERP; não tem preço aqui). */
export interface LinhaDeProduto {
  readonly nome: string;
  readonly codigo: string;
  readonly categoria: string;
  readonly sintese: string;
  readonly perfilAromatico: string;
  readonly descricao: string;
  readonly palavrasChave: readonly string[];
  readonly essencias: string;
}

export interface ConhecimentoDaOrganizacao {
  readonly organizacaoId: string;
  readonly nomeDaMarca: string;
  /** Primeira linha de toda resposta automática: atendimento automatizado, sem disfarce. */
  readonly identificacao: string;
  readonly tom: string;
  readonly linhas: readonly LinhaDeProduto[];
  readonly observacoesDasLinhas: readonly string[];
  /** Termos que indicam que a conversa é sobre a família de linhas. */
  readonly termosDaFamilia: readonly string[];
  readonly politicas: readonly Politica[];
  /** Produtos do ERP que não são vendáveis ao público (demonstração, teste). */
  readonly produtosOcultos: readonly RegExp[];
}

export { CONHECIMENTO_PORTAL_DO_HAUX };

const REGISTRO: ReadonlyMap<string, ConhecimentoDaOrganizacao> = new Map([
  [CONHECIMENTO_PORTAL_DO_HAUX.organizacaoId, CONHECIMENTO_PORTAL_DO_HAUX],
]);

/** Organização sem conhecimento registrado não recebe resposta comercial. */
export function conhecimentoDe(organizacaoId: string): ConhecimentoDaOrganizacao | null {
  return REGISTRO.get(organizacaoId) ?? null;
}

/** As políticas como o modelo deve vê-las: só as confirmadas viram fato. */
export function descreverPoliticas(conhecimento: ConhecimentoDaOrganizacao): string {
  return conhecimento.politicas.map((p) => (p.situacao === 'confirmada' && p.texto
    ? `- ${p.tema}: ${p.texto}`
    : `- ${p.tema}: NÃO INFORMADA (não afirme nada; ofereça falar com a equipe)`)).join('\n');
}
