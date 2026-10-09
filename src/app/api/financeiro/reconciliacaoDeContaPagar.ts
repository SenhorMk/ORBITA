import type { ContaPagarDetalhada, ContaPagarResumida, ListagemDeContasPagar } from '@/services/blingPort';
import type { LeituraRemota } from '@/lib/integrations/bling/operacaoRemotaContract';
import { SITUACAO_DA_CONTA_BLING } from '@/lib/integrations/bling/situacaoDaContaBling';

/**
 * Decisões da reconciliação (PRE-002), sem I/O.
 *
 * A regra que não se dobra: ausência de confirmação não é ausência do efeito, e
 * busca vazia não prova que a conta não foi criada. Por isso não existe aqui
 * nenhum desfecho "não foi criada": só `Comprovada` (prova inequívoca) ou
 * `RevisaoManual` (todo o resto). Nenhum desfecho autoriza um novo POST.
 */

/** Por que a reconciliação não concluiu. Vocabulário fechado, nosso. */
export type MotivoDeRevisaoManual =
  | 'sem_referencia'
  | 'consulta_incompleta'
  | 'listagem_incompleta'
  | 'nenhum_candidato'
  | 'multiplos_candidatos'
  | 'candidato_divergente'
  | 'candidatos_demais'
  | 'leitura_inconsistente'
  | 'conta_ausente'
  | 'conta_nao_quitada';

/** Teto de leituras por id numa reconciliação: acima disso, revisão manual. */
export const MAXIMO_DE_CANDIDATOS = 20;

/** O que a tentativa sabe sobre a conta que pediu ao Bling. */
export interface TentativaParaReconciliar {
  readonly valor: number;
  readonly dataVencimento: string;
  readonly dataEmissao: string;
  readonly contatoBlingId: number | null;
  /** `null` nas tentativas anteriores à migration 74: não há prova possível. */
  readonly numeroDocumento: string | null;
}

/** Desfecho de uma reconciliação. */
export type ProvaRemota =
  | { readonly _tag: 'Comprovada'; readonly conta: ContaPagarDetalhada; readonly candidatos: number }
  | { readonly _tag: 'RevisaoManual'; readonly motivo: MotivoDeRevisaoManual; readonly candidatos: number };

const emCentavos = (valor: number) => Math.round(valor * 100);

function revisao(motivo: MotivoDeRevisaoManual, candidatos: number): ProvaRemota {
  return { _tag: 'RevisaoManual', motivo, candidatos };
}

/**
 * Da listagem, as contas que podem ser a desta tentativa: mesmo valor, mesmo
 * vencimento e, quando conhecido, mesmo contato. Estreita a busca; não prova.
 *
 * @param tentativa - A intenção gravada.
 * @param contas - A listagem completa do Bling.
 * @returns Os candidatos a ler por id.
 */
export function candidatosDaListagem(
  tentativa: TentativaParaReconciliar,
  contas: readonly ContaPagarResumida[],
): readonly ContaPagarResumida[] {
  return contas.filter((conta) =>
    emCentavos(conta.valor) === emCentavos(tentativa.valor)
    && conta.vencimento === tentativa.dataVencimento
    && (tentativa.contatoBlingId === null || conta.contatoId === tentativa.contatoBlingId));
}

/**
 * Antes das leituras por id: a listagem já obriga a revisão manual?
 *
 * @param tentativa - A intenção gravada.
 * @param listagem - O que `GET /contas/pagar` devolveu.
 * @returns A revisão manual, ou os candidatos a ler.
 */
export function triarListagem(
  tentativa: TentativaParaReconciliar,
  listagem: ListagemDeContasPagar,
): ProvaRemota | { readonly _tag: 'LerCandidatos'; readonly candidatos: readonly ContaPagarResumida[] } {
  if (listagem._tag === 'ListagemIncompleta') return revisao('listagem_incompleta', 0);
  if (listagem._tag !== 'Listada') return revisao('consulta_incompleta', 0);
  const candidatos = candidatosDaListagem(tentativa, listagem.contas);
  if (candidatos.length > MAXIMO_DE_CANDIDATOS) return revisao('candidatos_demais', candidatos.length);
  return { _tag: 'LerCandidatos', candidatos };
}

function confere(tentativa: TentativaParaReconciliar, conta: ContaPagarDetalhada): boolean {
  return emCentavos(conta.valor) === emCentavos(tentativa.valor)
    && conta.vencimento === tentativa.dataVencimento
    && conta.dataEmissao === tentativa.dataEmissao
    && (tentativa.contatoBlingId === null || conta.contatoId === tentativa.contatoBlingId);
}

/**
 * Decide a criação a partir das leituras por id dos candidatos.
 *
 * Prova inequívoca: exatamente uma conta traz a referência desta tentativa em
 * `numeroDocumento`, e valor, vencimento, emissão e contato batem. Sem
 * referência gravada, nenhuma combinação de campos é prova — outra conta
 * idêntica pode ter sido lançada por alguém no mesmo dia.
 *
 * @param tentativa - A intenção gravada.
 * @param leituras - A leitura por id de cada candidato da listagem.
 * @returns `Comprovada` ou `RevisaoManual`.
 */
export function decidirCriacao(
  tentativa: TentativaParaReconciliar,
  leituras: readonly LeituraRemota<ContaPagarDetalhada>[],
): ProvaRemota {
  const candidatos = leituras.length;
  if (tentativa.numeroDocumento === null) return revisao('sem_referencia', candidatos);

  const contas: ContaPagarDetalhada[] = [];
  for (const leitura of leituras) {
    // A conta apareceu na listagem e sumiu na leitura: o Bling mudou entre as
    // duas consultas. Nada se conclui de um retrato inconsistente.
    if (leitura._tag === 'RemotoAusente') return revisao('leitura_inconsistente', candidatos);
    if (leitura._tag !== 'RemotoPresente') return revisao('consulta_incompleta', candidatos);
    contas.push(leitura.valor);
  }

  const comReferencia = contas.filter((conta) => conta.numeroDocumento === tentativa.numeroDocumento);
  if (comReferencia.some((conta) => !confere(tentativa, conta))) return revisao('candidato_divergente', candidatos);
  if (comReferencia.length === 0) return revisao('nenhum_candidato', candidatos);
  if (comReferencia.length > 1) return revisao('multiplos_candidatos', candidatos);
  const [conta] = comReferencia;
  return conta ? { _tag: 'Comprovada', conta, candidatos } : revisao('nenhum_candidato', candidatos);
}

/**
 * Decide a baixa a partir da leitura da conta, já conhecida por id.
 *
 * Prova: a conta lida é a desta baixa, está `Pago` (2) e, quando o Bling
 * informa o saldo, ele é zero. Aberta, parcial ou qualquer outra situação não
 * prova que a baixa não aconteceu — e nunca autoriza uma nova.
 *
 * @param blingContaId - A conta que a baixa quitava.
 * @param leitura - `GET /contas/pagar/{id}`.
 * @returns `Comprovada` ou `RevisaoManual`.
 */
export function decidirBaixa(blingContaId: string, leitura: LeituraRemota<ContaPagarDetalhada>): ProvaRemota {
  if (leitura._tag === 'RemotoAusente') return revisao('conta_ausente', 1);
  if (leitura._tag !== 'RemotoPresente') return revisao('consulta_incompleta', 1);
  const conta = leitura.valor;
  if (conta.id !== blingContaId) return revisao('leitura_inconsistente', 1);
  const quitada = conta.situacao === SITUACAO_DA_CONTA_BLING.pago && (conta.saldo === null || emCentavos(conta.saldo) === 0);
  return quitada ? { _tag: 'Comprovada', conta, candidatos: 1 } : revisao('conta_nao_quitada', 1);
}
