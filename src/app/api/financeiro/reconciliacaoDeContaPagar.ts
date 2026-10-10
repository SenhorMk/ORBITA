import type { BorderoLido, ContaPagarDetalhada, ContaPagarResumida, ListagemDeContasPagar } from '@/services/blingPort';
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
  | 'conta_nao_quitada'
  | 'saldo_ausente'
  | 'bordero_ausente'
  | 'borderos_demais'
  | 'quitada_sem_autoria'
  | 'multiplos_borderos'
  | 'conta_de_outra_operacao'
  | 'referencia_de_outra_operacao';

/** Teto de leituras por id numa reconciliação: acima disso, revisão manual. */
export const MAXIMO_DE_CANDIDATOS = 20;

/** Teto de borderôs lidos para provar a autoria de uma baixa. */
export const MAXIMO_DE_BORDEROS = 10;

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
  | {
      readonly _tag: 'Comprovada';
      readonly conta: ContaPagarDetalhada;
      readonly candidatos: number;
      /** Na baixa: o borderô do ORBITA que a prova. */
      readonly borderoId: string | null;
    }
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
  return conta ? { _tag: 'Comprovada', conta, candidatos, borderoId: null } : revisao('nenhum_candidato', candidatos);
}

/**
 * Primeira metade da prova da baixa: a conta lida está quitada?
 *
 * Exige `Pago` (2) e saldo INFORMADO e zero. Conta aberta ou parcial não prova
 * que a baixa não aconteceu — e nunca autoriza outra. Conta quitada ainda não
 * prova que foi o ORBITA quem quitou: isso é a segunda metade.
 *
 * @param blingContaId - A conta que a baixa quitava.
 * @param leitura - `GET /contas/pagar/{id}`.
 * @returns Revisão manual, ou os borderôs a ler.
 */
export function triarContaDaBaixa(
  blingContaId: string,
  leitura: LeituraRemota<ContaPagarDetalhada>,
): ProvaRemota | { readonly _tag: 'LerBorderos'; readonly conta: ContaPagarDetalhada } {
  if (leitura._tag === 'RemotoAusente') return revisao('conta_ausente', 1);
  if (leitura._tag !== 'RemotoPresente') return revisao('consulta_incompleta', 1);
  const conta = leitura.valor;
  if (conta.id !== blingContaId) return revisao('leitura_inconsistente', 1);
  if (conta.situacao !== SITUACAO_DA_CONTA_BLING.pago) return revisao('conta_nao_quitada', 1);
  if (conta.saldo === null) return revisao('saldo_ausente', 1);
  if (emCentavos(conta.saldo) !== 0) return revisao('conta_nao_quitada', 1);
  if (conta.borderos.length === 0) return revisao('bordero_ausente', 1);
  if (conta.borderos.length > MAXIMO_DE_BORDEROS) return revisao('borderos_demais', 1);
  return { _tag: 'LerBorderos', conta };
}

/**
 * Segunda metade: foi a baixa do ORBITA que quitou a conta?
 *
 * Prova de autoria: exatamente um borderô da conta traz no histórico a
 * referência desta baixa e tem a data dela. Conta paga sem esse borderô foi
 * paga por outra pessoa — a baixa do ORBITA continua sem desfecho.
 *
 * @param baixa - A referência e a data da intenção de baixa.
 * @param conta - A conta já triada como quitada.
 * @param leituras - A leitura de cada borderô da conta.
 * @returns `Comprovada` (com o borderô) ou `RevisaoManual`.
 */
export function decidirAutoriaDaBaixa(
  baixa: { readonly referencia: string; readonly dataBaixa: string },
  conta: ContaPagarDetalhada,
  leituras: readonly LeituraRemota<BorderoLido>[],
): ProvaRemota {
  const borderos: BorderoLido[] = [];
  for (const leitura of leituras) {
    if (leitura._tag === 'RemotoAusente') return revisao('leitura_inconsistente', 1);
    if (leitura._tag !== 'RemotoPresente') return revisao('consulta_incompleta', 1);
    borderos.push(leitura.valor);
  }
  const doOrbita = borderos.filter((b) => b.historico?.includes(baixa.referencia) === true && b.data === baixa.dataBaixa);
  if (doOrbita.length > 1) return revisao('multiplos_borderos', 1);
  const [bordero] = doOrbita;
  if (!bordero) return revisao('quitada_sem_autoria', 1);
  return { _tag: 'Comprovada', conta, candidatos: 1, borderoId: bordero.id };
}

/**
 * Confirmação manual: o operador aponta a conta no Bling; o servidor a lê por
 * id e só aceita se ela for compatível com a intenção gravada.
 *
 * É evidência humana — por isso o recibo leva o ator e o método
 * `confirmacao_manual` —, mas nunca contra os fatos: valor, vencimento,
 * emissão e contato precisam bater, e uma conta com a referência de OUTRA
 * operação é recusada.
 *
 * @param tentativa - A intenção gravada.
 * @param blingContaId - A conta apontada pelo operador.
 * @param leitura - `GET /contas/pagar/{id}` dessa conta.
 * @returns `Comprovada` ou `RevisaoManual` com o motivo da recusa.
 */
export function decidirConfirmacaoManual(
  tentativa: TentativaParaReconciliar,
  blingContaId: string,
  leitura: LeituraRemota<ContaPagarDetalhada>,
): ProvaRemota {
  if (leitura._tag === 'RemotoAusente') return revisao('conta_ausente', 1);
  if (leitura._tag !== 'RemotoPresente') return revisao('consulta_incompleta', 1);
  const conta = leitura.valor;
  if (conta.id !== blingContaId) return revisao('leitura_inconsistente', 1);
  if (conta.numeroDocumento !== null && conta.numeroDocumento !== tentativa.numeroDocumento) {
    return revisao('referencia_de_outra_operacao', 1);
  }
  if (!confere(tentativa, conta)) return revisao('candidato_divergente', 1);
  return { _tag: 'Comprovada', conta, candidatos: 1, borderoId: null };
}

/** O que falta resolver numa operação, na ordem em que precisa ser resolvido. */
export type PendenciaDaOperacao =
  | 'conferir_criacao'
  | 'reparo_titulo'
  | 'conferir_baixa'
  | 'reparo_titulo_pago'
  | 'quitacao_solicitada';

/**
 * A pendência de uma operação, a partir do estado durável.
 *
 * Uma operação só está concluída quando o Bling e a projeção local contam a
 * mesma história: criação confirmada COM título vinculado; baixa confirmada
 * COM título pago; quitação pedida no lançamento COM baixa ou título pago.
 *
 * @param operacao - O estado gravado.
 * @returns A pendência, ou `null` quando não há nada a fazer.
 */
export function pendenciaDaOperacao(operacao: {
  readonly estado: string;
  readonly tituloId: string | null;
  readonly tituloSituacao: string | null;
  readonly quitacaoSolicitada: boolean;
  readonly baixa: { readonly estado: string } | null;
}): PendenciaDaOperacao | null {
  if (operacao.estado === 'em_voo' || operacao.estado === 'indeterminada') return 'conferir_criacao';
  if (operacao.estado !== 'confirmada') return null;
  if (operacao.tituloId === null) return 'reparo_titulo';
  const baixa = operacao.baixa?.estado ?? null;
  if (baixa === 'em_voo' || baixa === 'indeterminada') return 'conferir_baixa';
  if (baixa === 'confirmada' && operacao.tituloSituacao === 'aberto') return 'reparo_titulo_pago';
  if (operacao.quitacaoSolicitada && (baixa === null || baixa === 'nao_enviada') && operacao.tituloSituacao === 'aberto') {
    return 'quitacao_solicitada';
  }
  return null;
}
