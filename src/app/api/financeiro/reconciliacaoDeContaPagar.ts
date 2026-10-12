import type { BorderoLido, ContaPagarDetalhada, ContaPagarResumida, ListagemDeContasPagar } from '@/services/blingPort';
import type { LeituraRemota } from '@/lib/integrations/bling/operacaoRemotaContract';
import {
  SITUACAO_DA_CONTA_BLING,
  projetarSituacaoDaConta,
  type SituacaoLocalDoTitulo,
} from '@/lib/integrations/bling/situacaoDaContaBling';

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
  | 'referencia_de_outra_operacao'
  | 'sem_evidencia_positiva'
  | 'titulo_inconsistente';

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
  const pagamento = decidirPagamentoConfirmado(blingContaId, leitura);
  if (pagamento._tag !== 'PagamentoConfirmado') return pagamento;
  const { conta } = pagamento;
  if (conta.borderos.length === 0) return revisao('bordero_ausente', 1);
  if (conta.borderos.length > MAXIMO_DE_BORDEROS) return revisao('borderos_demais', 1);
  return { _tag: 'LerBorderos', conta };
}

/**
 * Segunda metade: foi a baixa do ORBITA que quitou a conta?
 *
 * Prova de autoria: exatamente um borderô da conta traz no histórico a
 * referência desta baixa COMPLETA e delimitada (`[ORBQ-…]`, como o ORBITA a
 * envia) e tem a data dela. A referência como parte de outra sequência não
 * vale. Cada leitura tem de ser do borderô pedido, na ordem da conta: um id
 * devolvido diferente do pedido é leitura inconsistente. Conta paga sem esse
 * borderô foi paga por outra pessoa — a baixa do ORBITA continua sem desfecho.
 *
 * @param baixa - A referência e a data da intenção de baixa.
 * @param conta - A conta já triada como quitada.
 * @param leituras - A leitura de cada borderô de `conta.borderos`, na mesma ordem.
 * @returns `Comprovada` (com o borderô) ou `RevisaoManual`.
 */
export function decidirAutoriaDaBaixa(
  baixa: { readonly referencia: string; readonly dataBaixa: string },
  conta: ContaPagarDetalhada,
  leituras: readonly LeituraRemota<BorderoLido>[],
): ProvaRemota {
  if (leituras.length !== conta.borderos.length) return revisao('leitura_inconsistente', 1);
  const borderos: BorderoLido[] = [];
  for (const [i, leitura] of leituras.entries()) {
    if (leitura._tag === 'RemotoAusente') return revisao('leitura_inconsistente', 1);
    if (leitura._tag !== 'RemotoPresente') return revisao('consulta_incompleta', 1);
    if (leitura.valor.id !== conta.borderos[i]) return revisao('leitura_inconsistente', 1);
    borderos.push(leitura.valor);
  }
  const marca = `[${baixa.referencia}]`;
  const doOrbita = borderos.filter((b) => b.historico?.includes(marca) === true && b.data === baixa.dataBaixa);
  if (doOrbita.length > 1) return revisao('multiplos_borderos', 1);
  const [bordero] = doOrbita;
  if (!bordero) return revisao('quitada_sem_autoria', 1);
  return { _tag: 'Comprovada', conta, candidatos: 1, borderoId: bordero.id };
}

/** Como a confirmação manual se apoia: na referência da operação, ou na palavra do operador. */
export type MetodoDaConfirmacaoManual = 'confirmacao_manual' | 'declaracao_do_operador';

/**
 * Confirmação manual: o operador aponta a conta no Bling; o servidor a lê por
 * id e só aceita se ela for compatível com a intenção gravada.
 *
 * Valor, vencimento, emissão e contato iguais NÃO provam que a conta é desta
 * operação: uma conta independente pode ter exatamente esses atributos. Só a
 * referência da operação em `numeroDocumento` é evidência positiva. Sem ela, a
 * conta só é vinculada com a declaração explícita do operador, gravada no
 * recibo com o ator e o método `declaracao_do_operador` — nunca como prova.
 * Uma conta com a referência de OUTRA operação é sempre recusada.
 *
 * @param tentativa - A intenção gravada.
 * @param blingContaId - A conta apontada pelo operador.
 * @param leitura - `GET /contas/pagar/{id}` dessa conta.
 * @param declaracaoDoOperador - O operador declarou que conferiu que a conta é desta operação.
 * @returns A prova (ou a recusa) e o método que a sustenta.
 */
export function decidirConfirmacaoManual(
  tentativa: TentativaParaReconciliar,
  blingContaId: string,
  leitura: LeituraRemota<ContaPagarDetalhada>,
  declaracaoDoOperador: boolean,
): { readonly prova: ProvaRemota; readonly metodo: MetodoDaConfirmacaoManual } {
  const recusa = (motivo: MotivoDeRevisaoManual) => ({ prova: revisao(motivo, 1), metodo: 'confirmacao_manual' as const });
  if (leitura._tag === 'RemotoAusente') return recusa('conta_ausente');
  if (leitura._tag !== 'RemotoPresente') return recusa('consulta_incompleta');
  const conta = leitura.valor;
  if (conta.id !== blingContaId) return recusa('leitura_inconsistente');
  if (conta.numeroDocumento !== null && conta.numeroDocumento !== tentativa.numeroDocumento) {
    return recusa('referencia_de_outra_operacao');
  }
  if (!confere(tentativa, conta)) return recusa('candidato_divergente');
  const comprovada = { _tag: 'Comprovada' as const, conta, candidatos: 1, borderoId: null };
  if (conta.numeroDocumento !== null) return { prova: comprovada, metodo: 'confirmacao_manual' };
  if (!declaracaoDoOperador) return recusa('sem_evidencia_positiva');
  return { prova: comprovada, metodo: 'declaracao_do_operador' };
}

/**
 * A conta lida por id é a que a criação confirmou, e ainda corresponde à
 * intenção? Só então ela serve para reconstruir o título local.
 *
 * @param tentativa - A intenção gravada.
 * @param blingContaId - A conta remota confirmada na tentativa.
 * @param leitura - `GET /contas/pagar/{id}`.
 * @returns A conta, ou a revisão manual com o motivo.
 */
export function validarContaConfirmada(
  tentativa: TentativaParaReconciliar,
  blingContaId: string,
  leitura: LeituraRemota<ContaPagarDetalhada>,
): { readonly _tag: 'ContaValida'; readonly conta: ContaPagarDetalhada } | ProvaRemota {
  if (leitura._tag === 'RemotoAusente') return revisao('conta_ausente', 1);
  if (leitura._tag !== 'RemotoPresente') return revisao('consulta_incompleta', 1);
  if (leitura.valor.id !== blingContaId) return revisao('leitura_inconsistente', 1);
  if (!confere(tentativa, leitura.valor)) return revisao('candidato_divergente', 1);
  return { _tag: 'ContaValida', conta: leitura.valor };
}

/** A conta lida, vista como pré-condição para quitar. */
export type ContaParaQuitar =
  | { readonly _tag: 'Quitavel' | 'JaPaga' | 'NaoQuitavel'; readonly conta: ContaPagarDetalhada }
  /** Outra conta, ou a conta não corresponde mais à intenção (id, valor, datas, fornecedor). */
  | { readonly _tag: 'Divergente' }
  /** Situação e saldo se contradizem: nada a afirmar, nada a enviar. */
  | { readonly _tag: 'Inconsistente' }
  | { readonly _tag: 'Indisponivel' };

/**
 * As pré-condições verificáveis antes de quitar: a leitura é da conta
 * confirmada, ainda compatível com a intenção, e situação e saldo contam a
 * mesma história — em aberto com o saldo integral, ou paga com saldo zero.
 * Uma mudança no Bling DEPOIS desta leitura não é controlável daqui; a
 * intenção durável e a referência no histórico cobrem esse intervalo.
 *
 * @param tentativa - A intenção gravada.
 * @param blingContaId - A conta remota confirmada.
 * @param leitura - `GET /contas/pagar/{id}`, imediatamente antes de quitar.
 * @returns Se a conta pode ser quitada, já está paga, ou por que não.
 */
export function decidirContaQuitavel(
  tentativa: TentativaParaReconciliar,
  blingContaId: string,
  leitura: LeituraRemota<ContaPagarDetalhada>,
): ContaParaQuitar {
  if (leitura._tag === 'RemotoAusente') return { _tag: 'Divergente' };
  if (leitura._tag !== 'RemotoPresente') return { _tag: 'Indisponivel' };
  if (validarContaConfirmada(tentativa, blingContaId, leitura)._tag !== 'ContaValida') return { _tag: 'Divergente' };
  const conta = leitura.valor;
  if (conta.situacao === SITUACAO_DA_CONTA_BLING.pago) {
    return decidirPagamentoConfirmado(blingContaId, leitura)._tag === 'PagamentoConfirmado'
      ? { _tag: 'JaPaga', conta }
      : { _tag: 'Inconsistente' };
  }
  if (conta.situacao !== SITUACAO_DA_CONTA_BLING.aberto) return { _tag: 'NaoQuitavel', conta };
  if (conta.saldo === null || emCentavos(conta.saldo) !== emCentavos(conta.valor)) return { _tag: 'Inconsistente' };
  return { _tag: 'Quitavel', conta };
}

/**
 * A conta está paga, de forma completa? `Pago` com saldo INFORMADO e zero.
 * Diz que houve pagamento — não diz de quem: autoria é `decidirAutoriaDaBaixa`.
 *
 * @param blingContaId - A conta esperada.
 * @param leitura - `GET /contas/pagar/{id}`.
 * @returns O pagamento confirmado, ou a revisão manual com o motivo.
 */
export function decidirPagamentoConfirmado(
  blingContaId: string,
  leitura: LeituraRemota<ContaPagarDetalhada>,
): { readonly _tag: 'PagamentoConfirmado'; readonly conta: ContaPagarDetalhada } | ProvaRemota {
  if (leitura._tag === 'RemotoAusente') return revisao('conta_ausente', 1);
  if (leitura._tag !== 'RemotoPresente') return revisao('consulta_incompleta', 1);
  const conta = leitura.valor;
  if (conta.id !== blingContaId) return revisao('leitura_inconsistente', 1);
  if (conta.situacao !== SITUACAO_DA_CONTA_BLING.pago) return revisao('conta_nao_quitada', 1);
  if (conta.saldo === null) return revisao('saldo_ausente', 1);
  if (emCentavos(conta.saldo) !== 0) return revisao('conta_nao_quitada', 1);
  return { _tag: 'PagamentoConfirmado', conta };
}

/**
 * A situação do título local a partir da conta lida. `pago` só com pagamento
 * confirmado (saldo informado e zero): uma leitura incompleta nunca marca
 * pagamento — o título fica aberto.
 *
 * @param conta - A conta lida por id.
 * @returns A situação local.
 */
export function situacaoLocalComprovada(conta: ContaPagarDetalhada): SituacaoLocalDoTitulo {
  const projetada = projetarSituacaoDaConta(conta.situacao);
  if (projetada !== 'pago') return projetada;
  return conta.saldo !== null && emCentavos(conta.saldo) === 0 ? 'pago' : 'aberto';
}

/** O que falta resolver numa operação, na ordem em que precisa ser resolvido. */
export type PendenciaDaOperacao =
  | 'conferir_criacao'
  | 'reparo_titulo'
  | 'titulo_inconsistente'
  | 'conferir_baixa'
  | 'reparo_titulo_pago'
  | 'quitacao_recusada'
  | 'pagamento_nao_comprovado'
  | 'quitacao_solicitada';

const SITUACOES_LOCAIS: ReadonlySet<string> = new Set(['aberto', 'pago', 'cancelado', 'estornado']);

/**
 * A pendência de uma operação, a partir do estado durável. É a MESMA regra de
 * `listar_pendencias_conta_pagar` (migration 74), que lista no banco.
 *
 * Uma operação só está concluída quando o Bling e a projeção local contam a
 * mesma história: criação confirmada COM título encontrado na organização;
 * baixa confirmada COM título pago; quitação pedida COM título pago. Um
 * `tituloId` sem título encontrado (ou com situação desconhecida, ou cancelado
 * com quitação em jogo) é inconsistência local: fica visível e bloqueada, sem
 * reparo automático. Quitação recusada com o título aberto continua pendente.
 *
 * @param operacao - O estado gravado.
 * @returns A pendência, ou `null` quando não há nada a fazer.
 */
export function pendenciaDaOperacao(operacao: {
  readonly estado: string;
  readonly tituloId: string | null;
  readonly tituloSituacao: string | null;
  /** A situação do Bling gravada no título (`situacao_bling`), quando conhecida. */
  readonly tituloSituacaoBling?: number | null;
  readonly quitacaoSolicitada: boolean;
  readonly baixa: { readonly estado: string } | null;
}): PendenciaDaOperacao | null {
  if (operacao.estado === 'em_voo' || operacao.estado === 'indeterminada') return 'conferir_criacao';
  if (operacao.estado !== 'confirmada') return null;
  if (operacao.tituloId === null) return 'reparo_titulo';
  const situacao = operacao.tituloSituacao;
  const baixa = operacao.baixa?.estado ?? null;
  if (situacao === null || !SITUACOES_LOCAIS.has(situacao)) return 'titulo_inconsistente';
  if ((situacao === 'cancelado' || situacao === 'estornado') && (operacao.quitacaoSolicitada || baixa !== null)) {
    return 'titulo_inconsistente';
  }
  if (baixa === 'em_voo' || baixa === 'indeterminada') return 'conferir_baixa';
  if (situacao !== 'aberto') return null;
  if (baixa === 'confirmada') return 'reparo_titulo_pago';
  if (baixa === 'recusada') return 'quitacao_recusada';
  // O Bling diz `Pago` e o saldo não comprovou: o título ficou aberto, e a
  // divergência fica na fila até uma leitura completa resolvê-la.
  if (operacao.tituloSituacaoBling === SITUACAO_DA_CONTA_BLING.pago) return 'pagamento_nao_comprovado';
  if (operacao.quitacaoSolicitada && (baixa === null || baixa === 'nao_enviada')) return 'quitacao_solicitada';
  return null;
}
