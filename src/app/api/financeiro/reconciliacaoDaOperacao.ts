import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import type { BlingPort } from '@/services/blingPort';

import type { DespesaStorePort, GravacaoDeTentativa } from './despesaHandler';
import { quitar, type QuitacaoDependencies } from './quitacaoDaConta';
import {
  decidirConfirmacaoManual,
  decidirContaQuitavel,
  decidirPagamentoConfirmado,
  pendenciaDaOperacao,
  validarContaConfirmada,
  type MotivoDeRevisaoManual,
  type ProvaRemota,
} from './reconciliacaoDeContaPagar';
import { fechar, gravarTituloDaConta, provarBaixa, provarCriacao, registrarEvento } from './projecaoDaOperacao';

type Estado = 'em_voo' | 'nao_enviada' | 'confirmada' | 'recusada' | 'indeterminada';

/** Uma operação de conta a pagar, com a baixa, o título e o último recibo. */
export interface OperacaoRegistrada {
  readonly tentativaId: string;
  readonly ref: string;
  readonly estado: Estado;
  readonly valor: number;
  readonly dataVencimento: string;
  readonly dataEmissao: string;
  readonly contatoBlingId: number | null;
  readonly numeroDocumento: string | null;
  readonly quitacaoSolicitada: boolean;
  readonly blingContaId: string | null;
  readonly tituloId: string | null;
  /** Situação do título local (`aberto`, `pago`, ...), ou `null` sem título. */
  readonly tituloSituacao: string | null;
  /** O código do Bling gravado no título (`situacao_bling`), ou `null`. */
  readonly tituloSituacaoBling: number | null;
  readonly baixa: {
    readonly id: string;
    readonly estado: Estado;
    readonly blingContaId: string;
    readonly dataBaixa: string;
  } | null;
  readonly ultimaReconciliacao: {
    readonly alvo: 'criacao' | 'baixa';
    readonly metodo: RegistroDeReconciliacao['metodo'];
    readonly resultado: 'confirmada' | 'ja_confirmada' | 'revisao_manual' | 'divergente';
    readonly motivo: MotivoDeRevisaoManual | null;
    readonly em: string;
  } | null;
}

/** Posição na lista de pendências: a criação exata (como o banco a grava) e a chave. */
export interface CursorDePendencias {
  readonly criadaEm: string;
  readonly ref: string;
}

/** Quantas pendências cabem numa página. */
export const PENDENCIAS_POR_PAGINA = 100;

/** O que a reconciliação grava, na mesma transação, pela migration 74. */
export interface RegistroDeReconciliacao {
  readonly ref: string;
  readonly alvo: 'criacao' | 'baixa';
  readonly correlationId: string;
  readonly metodo:
    | 'referencia_no_numero_documento' | 'leitura_por_id' | 'leitura_de_borderos'
    | 'confirmacao_manual' | 'declaracao_do_operador' | 'sem_metodo_seguro';
  readonly prova: ProvaRemota;
}

/** Persistência das operações e dos recibos. */
export interface OperacoesStorePort {
  lerOperacao(scope: VerifiedOrganizationScope, ref: string): Promise<
    | { readonly _tag: 'Encontrada'; readonly operacao: OperacaoRegistrada }
    | { readonly _tag: 'NaoEncontrada' }
    | { readonly _tag: 'Indisponivel' }
  >;
  /**
   * Uma página das operações com alguma pendência, decididas NO BANCO pela
   * regra de `pendenciaDaOperacao`. `total` conta todas; `proximo` é o cursor
   * estável `(criação, chave)` da página seguinte, ou `null` na última.
   */
  listarPendentes(scope: VerifiedOrganizationScope, apos?: CursorDePendencias): Promise<
    | {
        readonly _tag: 'Listadas';
        readonly operacoes: readonly OperacaoRegistrada[];
        readonly total: number;
        readonly proximo: CursorDePendencias | null;
      }
    | { readonly _tag: 'Indisponivel' }
  >;
  registrarReconciliacao(scope: VerifiedOrganizationScope, registro: RegistroDeReconciliacao): Promise<
    | {
        readonly _tag: 'Registrada';
        readonly resultado: 'confirmada' | 'ja_confirmada' | 'revisao_manual' | 'divergente';
        readonly motivo: MotivoDeRevisaoManual | null;
      }
    | { readonly _tag: 'Indisponivel' }
  >;
  categoriaLocalPorBlingId(scope: VerifiedOrganizationScope, categoriaBlingId: number): Promise<string | null>;
  marcarTituloPago(scope: VerifiedOrganizationScope, tituloId: string): Promise<GravacaoDeTentativa>;
}

export type LeiturasDoBling = Pick<BlingPort, 'listarContasPagarParaReconciliacao' | 'lerContaPagarParaReconciliacao' | 'lerBorderoParaReconciliacao'>;

/** Dependências da reconciliação. Do Bling, só leitura: nenhum POST é possível daqui. */
export interface ReconciliacaoDependencies {
  readonly operacoes: OperacoesStorePort;
  readonly titulos: Pick<DespesaStorePort, 'salvarTitulo' | 'vincularTitulo'>;
  readonly bling: (scope: VerifiedOrganizationScope) => LeiturasDoBling;
}

/** A quitação explícita é o único caminho daqui que escreve no Bling. */
export interface QuitacaoDaOperacaoDependencies extends ReconciliacaoDependencies {
  readonly escrita: (scope: VerifiedOrganizationScope) => QuitacaoDependencies;
}

/**
 * Se o ORBITA conta a mesma história que o Bling: `pendente` quando o registro
 * local está incompleto; `divergente` quando o Bling diz `Pago` sem saldo
 * comprovado e o título segue aberto.
 */
export type ProjecaoLocal = 'consistente' | 'pendente' | 'divergente';

type ResultadoComOperacao<R> =
  | { readonly _tag: 'NaoEncontrada' }
  | { readonly _tag: 'Indisponivel' }
  | ({ readonly _tag: 'Reconciliada'; readonly operacao: OperacaoRegistrada; readonly projecaoLocal: ProjecaoLocal } & R);

/** Resultado de pedir a reconciliação (ou a confirmação manual) de uma operação. */
export type ResultadoDaReconciliacao = ResultadoComOperacao<{
  readonly resultado: 'confirmada' | 'ja_confirmada' | 'revisao_manual' | 'divergente' | 'nada_pendente' | 'reparo_local';
  readonly motivo: MotivoDeRevisaoManual | null;
}>;

/** Resultado da quitação explícita. */
export type ResultadoDaQuitacaoDaOperacao = ResultadoComOperacao<{
  readonly resultado:
    | 'quitada' | 'quitacao_nao_confirmada' | 'quitacao_recusada' | 'quitacao_nao_enviada'
    | 'ja_quitada_no_bling' | 'conta_divergente' | 'conta_inconsistente' | 'conta_nao_quitavel' | 'sem_categoria' | 'consulta_incompleta'
    | 'nada_pendente';
}>;

/** Grava o recibo, faz a projeção local que a prova permite e relê. */
async function registrarEFechar(
  scope: VerifiedOrganizationScope,
  operacao: OperacaoRegistrada,
  registro: RegistroDeReconciliacao,
  deps: ReconciliacaoDependencies,
): Promise<ResultadoDaReconciliacao> {
  const gravado = await deps.operacoes.registrarReconciliacao(scope, registro);
  if (gravado._tag !== 'Registrada') return { _tag: 'Indisponivel' };
  const { prova } = registro;
  const confirmou = (gravado.resultado === 'confirmada' || gravado.resultado === 'ja_confirmada') && prova._tag === 'Comprovada';
  if (confirmou && registro.alvo === 'criacao') await gravarTituloDaConta(scope, operacao, prova.conta, deps);
  if (confirmou && registro.alvo === 'baixa' && operacao.tituloId !== null) await deps.operacoes.marcarTituloPago(scope, operacao.tituloId);

  const motivo = prova._tag === 'RevisaoManual' ? prova.motivo : gravado.motivo;
  const fechada = await fechar(scope, registro.ref, operacao, deps);
  const evento = prova._tag === 'RevisaoManual' || !confirmou ? 'financeiro.reconciliacao.manual_review'
    : registro.alvo === 'baixa' ? 'financeiro.baixa.reconciliada' : 'financeiro.reconciliacao.confirmada';
  registrarEvento(evento, scope, operacao, registro.correlationId, {
    alvo: registro.alvo, metodo: registro.metodo, resultado: gravado.resultado, motivo, projecao: fechada.projecaoLocal,
  });
  return { _tag: 'Reconciliada', resultado: gravado.resultado, motivo, ...fechada };
}

/**
 * Concilia uma operação com o Bling, sem nunca repetir criação ou baixa: o
 * Bling só é lido. Prova inequívoca confirma; todo o resto vira revisão manual,
 * com recibo. Uma operação confirmada com a projeção local incompleta (título
 * não gravado/vinculado, título não marcado pago) é reparada aqui, de forma
 * idempotente.
 *
 * @param scope - Organização e ator verificados no servidor.
 * @param ref - A `operation_ref`; sozinha não dá acesso — a leitura filtra a organização.
 * @param correlationId - Correlação da requisição.
 * @param deps - Portas.
 * @returns O desfecho, a projeção local e a operação como ficou.
 */
export async function reconciliarOperacao(
  scope: VerifiedOrganizationScope,
  ref: string,
  correlationId: string,
  deps: ReconciliacaoDependencies,
): Promise<ResultadoDaReconciliacao> {
  const lida = await deps.operacoes.lerOperacao(scope, ref);
  if (lida._tag !== 'Encontrada') return lida;
  const { operacao } = lida;
  const pendencia = pendenciaDaOperacao(operacao);
  const bling = deps.bling(scope);
  registrarEvento('financeiro.reconciliacao.iniciada', scope, operacao, correlationId, { pendencia });

  switch (pendencia) {
    case 'conferir_criacao':
      return registrarEFechar(scope, operacao, {
        ref, alvo: 'criacao', correlationId,
        metodo: operacao.numeroDocumento ? 'referencia_no_numero_documento' : 'sem_metodo_seguro',
        prova: await provarCriacao(operacao, bling),
      }, deps);
    case 'conferir_baixa':
      return operacao.baixa
        ? registrarEFechar(scope, operacao, {
            ref, alvo: 'baixa', correlationId, metodo: 'leitura_de_borderos', prova: await provarBaixa(operacao.baixa, bling),
          }, deps)
        : { _tag: 'Indisponivel' };
    case 'reparo_titulo': {
      // A criação já está provada; o Bling só é LIDO para montar o título, e
      // só uma leitura da MESMA conta, ainda compatível com a intenção, serve.
      if (operacao.blingContaId === null) return { _tag: 'Indisponivel' };
      const validada = validarContaConfirmada(
        operacao, operacao.blingContaId, await bling.lerContaPagarParaReconciliacao(operacao.blingContaId),
      );
      if (validada._tag === 'ContaValida') await gravarTituloDaConta(scope, operacao, validada.conta, deps);
      const fechada = await fechar(scope, ref, operacao, deps);
      registrarEvento(fechada.projecaoLocal === 'consistente' ? 'financeiro.reconciliacao.reparada' : 'financeiro.reconciliacao.reparo_pendente',
        scope, operacao, correlationId, { pendencia, motivo: validada._tag === 'RevisaoManual' ? validada.motivo : null });
      return { _tag: 'Reconciliada', resultado: 'reparo_local', motivo: validada._tag === 'RevisaoManual' ? validada.motivo : null, ...fechada };
    }
    case 'pagamento_nao_comprovado': {
      // Só leitura: com a conta confirmada e compatível, o título é regravado
      // pelo que ela diz agora — pago só com saldo zero; reaberta, volta a
      // concordar. Sem leitura completa, a pendência fica.
      if (operacao.blingContaId === null) return { _tag: 'Indisponivel' };
      const leitura = await bling.lerContaPagarParaReconciliacao(operacao.blingContaId);
      const validada = validarContaConfirmada(operacao, operacao.blingContaId, leitura);
      if (validada._tag === 'ContaValida') await gravarTituloDaConta(scope, operacao, validada.conta, deps);
      const fechada = await fechar(scope, ref, operacao, deps);
      const pagamento = decidirPagamentoConfirmado(operacao.blingContaId, leitura);
      const motivo = validada._tag === 'RevisaoManual' ? validada.motivo : pagamento._tag === 'RevisaoManual' ? pagamento.motivo : null;
      const resolvida = pendenciaDaOperacao(fechada.operacao) !== 'pagamento_nao_comprovado';
      registrarEvento(resolvida ? 'financeiro.reconciliacao.reparada' : 'financeiro.reconciliacao.manual_review',
        scope, operacao, correlationId, { pendencia, motivo });
      return resolvida
        ? { _tag: 'Reconciliada', resultado: 'reparo_local', motivo: null, ...fechada }
        : { _tag: 'Reconciliada', resultado: 'revisao_manual', motivo, ...fechada };
    }
    case 'titulo_inconsistente':
      // O vínculo aponta um título que não está na organização, ou que conta
      // outra história. Nada é reparado sozinho: correção administrativa.
      registrarEvento('financeiro.reconciliacao.manual_review', scope, operacao, correlationId, { pendencia });
      return { _tag: 'Reconciliada', resultado: 'revisao_manual', motivo: 'titulo_inconsistente', operacao, projecaoLocal: 'pendente' };
    case 'quitacao_recusada': {
      // A baixa do ORBITA foi recusada: não aconteceu, e não é reenviada.
      // Se a conta aparece paga por completo, alguém pagou por fora — o título
      // conta o pagamento, sem atribuí-lo ao ORBITA.
      if (operacao.baixa === null) return { _tag: 'Indisponivel' };
      const pagamento = decidirPagamentoConfirmado(
        operacao.baixa.blingContaId, await bling.lerContaPagarParaReconciliacao(operacao.baixa.blingContaId),
      );
      const prova: ProvaRemota = pagamento._tag === 'PagamentoConfirmado'
        ? { _tag: 'RevisaoManual', motivo: 'quitada_sem_autoria', candidatos: 1 }
        : pagamento;
      const gravado = await deps.operacoes.registrarReconciliacao(scope, { ref, alvo: 'baixa', correlationId, metodo: 'leitura_por_id', prova });
      if (gravado._tag !== 'Registrada') return { _tag: 'Indisponivel' };
      if (pagamento._tag === 'PagamentoConfirmado' && operacao.tituloId !== null) {
        await deps.operacoes.marcarTituloPago(scope, operacao.tituloId);
      }
      const fechada = await fechar(scope, ref, operacao, deps);
      const motivo = prova._tag === 'RevisaoManual' ? prova.motivo : null;
      registrarEvento('financeiro.reconciliacao.manual_review', scope, operacao, correlationId, { pendencia, motivo, projecao: fechada.projecaoLocal });
      return { _tag: 'Reconciliada', resultado: 'revisao_manual', motivo, ...fechada };
    }
    case 'reparo_titulo_pago': {
      if (operacao.tituloId !== null) await deps.operacoes.marcarTituloPago(scope, operacao.tituloId);
      const fechada = await fechar(scope, ref, operacao, deps);
      registrarEvento(fechada.projecaoLocal === 'consistente' ? 'financeiro.reconciliacao.reparada' : 'financeiro.reconciliacao.reparo_pendente',
        scope, operacao, correlationId, { pendencia });
      return { _tag: 'Reconciliada', resultado: 'reparo_local', motivo: null, ...fechada };
    }
    case 'quitacao_solicitada':
    case null:
      // A quitação pedida no lançamento NÃO é feita aqui: ela é uma ação
      // explícita do operador (`quitarOperacao`).
      return { _tag: 'Reconciliada', resultado: 'nada_pendente', motivo: null, operacao, projecaoLocal: 'consistente' };
  }
}

/**
 * Confirmação manual: o operador aponta a conta que conferiu no Bling. O
 * servidor a lê por id e só aceita se ela for compatível com a intenção. Com a
 * referência da operação na conta, é evidência (`confirmacao_manual`); sem ela,
 * só com a declaração explícita do operador (`declaracao_do_operador`), que o
 * recibo grava com o ator. Nunca cria nada no Bling.
 *
 * @param scope - Organização e ator verificados.
 * @param ref - A `operation_ref`.
 * @param blingContaId - A conta apontada pelo operador.
 * @param correlationId - Correlação da requisição.
 * @param deps - Portas.
 * @param opcoes - `declaracaoDoOperador`: o operador declara que conferiu que a conta é desta operação.
 * @returns O desfecho.
 */
export async function confirmarManualmente(
  scope: VerifiedOrganizationScope,
  ref: string,
  blingContaId: string,
  correlationId: string,
  deps: ReconciliacaoDependencies,
  opcoes: { readonly declaracaoDoOperador?: boolean } = {},
): Promise<ResultadoDaReconciliacao> {
  const lida = await deps.operacoes.lerOperacao(scope, ref);
  if (lida._tag !== 'Encontrada') return lida;
  const { operacao } = lida;
  if (pendenciaDaOperacao(operacao) !== 'conferir_criacao') {
    return { _tag: 'Reconciliada', resultado: 'nada_pendente', motivo: null, ...(await fechar(scope, ref, operacao, deps)) };
  }
  const leitura = await deps.bling(scope).lerContaPagarParaReconciliacao(blingContaId);
  const { prova, metodo } = decidirConfirmacaoManual(operacao, blingContaId, leitura, opcoes.declaracaoDoOperador === true);
  return registrarEFechar(scope, operacao, { ref, alvo: 'criacao', correlationId, metodo, prova }, deps);
}

/**
 * Quita a conta de uma operação cujo lançamento pediu a quitação, quando a
 * criação foi confirmada sem ela (ACK perdido). Ação EXPLÍCITA do operador:
 * a conta é lida antes (já paga ou não quitável → nada é enviado), e a baixa
 * passa pela intenção durável de `quitar` — repetir não envia outra.
 *
 * @param scope - Organização e ator verificados.
 * @param ref - A `operation_ref`.
 * @param correlationId - Correlação da requisição.
 * @param deps - Portas, inclusive a de escrita no Bling.
 * @returns O desfecho.
 */
export async function quitarOperacao(
  scope: VerifiedOrganizationScope,
  ref: string,
  correlationId: string,
  deps: QuitacaoDaOperacaoDependencies,
): Promise<ResultadoDaQuitacaoDaOperacao> {
  const lida = await deps.operacoes.lerOperacao(scope, ref);
  if (lida._tag !== 'Encontrada') return lida;
  const { operacao } = lida;
  const responder = async (resultado: Extract<ResultadoDaQuitacaoDaOperacao, { _tag: 'Reconciliada' }>['resultado']) => {
    registrarEvento('financeiro.quitacao.solicitada', scope, operacao, correlationId, { resultado });
    return { _tag: 'Reconciliada' as const, resultado, ...(await fechar(scope, ref, operacao, deps)) };
  };
  if (pendenciaDaOperacao(operacao) !== 'quitacao_solicitada' || operacao.blingContaId === null || operacao.tituloId === null) {
    return responder('nada_pendente');
  }

  // Pré-condições verificáveis ANTES do POST: a conta confirmada, ainda
  // compatível com a intenção, com situação e saldo coerentes.
  const paraQuitar = decidirContaQuitavel(
    operacao, operacao.blingContaId, await deps.bling(scope).lerContaPagarParaReconciliacao(operacao.blingContaId),
  );
  switch (paraQuitar._tag) {
    case 'Indisponivel': return responder('consulta_incompleta');
    case 'Divergente': return responder('conta_divergente');
    case 'Inconsistente': return responder('conta_inconsistente');
    case 'NaoQuitavel': return responder('conta_nao_quitavel');
    case 'JaPaga':
      // Paga por alguém, fora desta operação, com saldo zero: nada é enviado,
      // e o título conta o pagamento sem atribuí-lo ao ORBITA.
      await deps.operacoes.marcarTituloPago(scope, operacao.tituloId);
      return responder('ja_quitada_no_bling');
    case 'Quitavel':
      break;
  }
  const { conta } = paraQuitar;
  if (conta.categoriaId === null) return responder('sem_categoria');

  const quitacao = await quitar(
    scope,
    { ref, tentativaId: operacao.tentativaId, blingContaId: operacao.blingContaId },
    conta.historico?.trim() || 'Quitação de despesa',
    conta.categoriaId,
    deps.escrita(scope),
  );
  if (quitacao.quitada) await deps.operacoes.marcarTituloPago(scope, operacao.tituloId);
  switch (quitacao.desfecho) {
    case 'confirmada': return responder('quitada');
    case 'recusada': return responder('quitacao_recusada');
    case 'nao_enviada':
    case 'pre_requisito': return responder('quitacao_nao_enviada');
    case 'indeterminada': return responder('quitacao_nao_confirmada');
    case 'nao_reivindicada': return responder(quitacao.quitada ? 'quitada' : 'nada_pendente');
  }
}
