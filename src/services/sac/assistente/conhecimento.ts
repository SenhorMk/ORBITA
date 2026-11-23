/**
 * O que o assistente sabe de cada organização, separado das regras globais.
 *
 * Regras globais (comportamento, segurança, limites) ficam em
 * `respostaAutomaticaHaux.ts`/`docs/ai/ASSISTENTE_ORBITA.md`. Aqui ficam só a
 * identidade e as políticas comerciais de uma organização, cada uma com a sua
 * situação: `confirmada` (com fonte), `pendente` (aguarda aprovação do
 * comerciante) ou `indisponivel`. Política que não está `confirmada` nunca
 * chega ao modelo como fato: chega como "não informada", e a resposta orienta
 * a falar com a equipe.
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

export interface ConhecimentoDaOrganizacao {
  readonly organizacaoId: string;
  readonly nomeDaMarca: string;
  /** Primeira linha de toda resposta automática: atendimento automatizado, sem disfarce. */
  readonly identificacao: string;
  readonly tom: string;
  readonly politicas: readonly Politica[];
  /** Produtos do ERP que não são vendáveis ao público (demonstração, teste). */
  readonly produtosOcultos: readonly RegExp[];
}

/**
 * Portal do Haux. Nenhuma política comercial foi aprovada até 23/11/2026:
 * as fontes do Portal (BRAND.md, briefing dos defumadores, tema Shopify) não
 * trazem troca, frete, prazo ou pagamento. Ver a seção de decisões pendentes
 * em `docs/ai/ASSISTENTE_ORBITA.md`.
 */
export const CONHECIMENTO_PORTAL_DO_HAUX: ConhecimentoDaOrganizacao = {
  organizacaoId: 'c75eb92d-9222-49cc-ac0f-6aebaf8fa69f',
  nomeDaMarca: 'Portal do Haux',
  identificacao: 'Assistente virtual do Portal do Haux',
  tom: 'Acolhedor, respeitoso e direto, em português do Brasil; sem gírias forçadas e sem promessas.',
  politicas: [
    { tema: 'formas de pagamento', situacao: 'pendente' },
    { tema: 'frete e entrega', situacao: 'pendente' },
    { tema: 'prazo de preparação e postagem', situacao: 'pendente' },
    { tema: 'trocas e devoluções', situacao: 'pendente' },
    { tema: 'cancelamento e reembolso', situacao: 'pendente' },
    { tema: 'promoções e descontos', situacao: 'indisponivel' },
    { tema: 'rastreamento de pedidos pelo assistente', situacao: 'indisponivel' },
  ],
  produtosOcultos: [/^\s*demo\b/iu, /\bteste\b/iu, /\bpremium orbita\b/iu],
};

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
