import { CONHECIMENTO_PORTAL_DO_HAUX } from './organizacoes/portalDoHaux';
import type { RegistroDePolitica } from './politicas';

/**
 * O que o assistente sabe de cada organização, separado das regras globais.
 *
 * Regras globais (comportamento, segurança, limites) ficam em
 * `respostaAutomaticaHaux.ts`/`docs/ai/ASSISTENTE_ORBITA.md`. Cada organização
 * tem o seu arquivo em `organizacoes/` (identidade, linhas de produto,
 * políticas como registros rastreáveis, ver `politicas.ts`). Política que não
 * está `confirmada` e vigente nunca chega ao modelo como fato. Preço e estoque
 * nunca ficam aqui: vêm do ERP.
 */

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
  readonly politicas: readonly RegistroDePolitica[];
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
