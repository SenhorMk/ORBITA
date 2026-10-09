import { projetarSituacaoDaConta } from '@/lib/integrations/bling/situacaoDaContaBling';
import { logger } from '@/lib/observability/logger';
import { registrarFalhaInterna } from '@/lib/observability/falhaInterna';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import type { BlingPort, ContaPagarDetalhada } from '@/services/blingPort';

import type { DespesaStorePort, GravacaoDeTentativa } from './despesaHandler';
import {
  decidirBaixa,
  decidirCriacao,
  triarListagem,
  type MotivoDeRevisaoManual,
  type ProvaRemota,
} from './reconciliacaoDeContaPagar';

/** Uma operação de conta a pagar, com a baixa e o último recibo. */
export interface OperacaoRegistrada {
  readonly tentativaId: string;
  readonly ref: string;
  readonly estado: 'em_voo' | 'nao_enviada' | 'confirmada' | 'recusada' | 'indeterminada';
  readonly valor: number;
  readonly dataVencimento: string;
  readonly dataEmissao: string;
  readonly contatoBlingId: number | null;
  readonly numeroDocumento: string | null;
  readonly blingContaId: string | null;
  readonly tituloId: string | null;
  readonly baixa: {
    readonly estado: 'em_voo' | 'nao_enviada' | 'confirmada' | 'recusada' | 'indeterminada';
    readonly blingContaId: string;
  } | null;
  readonly ultimaReconciliacao: {
    readonly alvo: 'criacao' | 'baixa';
    readonly resultado: 'confirmada' | 'ja_confirmada' | 'revisao_manual' | 'divergente';
    readonly motivo: MotivoDeRevisaoManual | null;
    readonly em: string;
  } | null;
}

/** O que a reconciliação grava, na mesma transação, pela migration 74. */
export interface RegistroDeReconciliacao {
  readonly ref: string;
  readonly alvo: 'criacao' | 'baixa';
  readonly correlationId: string;
  readonly metodo: 'referencia_no_numero_documento' | 'leitura_por_id' | 'sem_metodo_seguro';
  readonly prova: ProvaRemota;
}

/** Persistência das operações e dos recibos. */
export interface OperacoesStorePort {
  lerOperacao(scope: VerifiedOrganizationScope, ref: string): Promise<
    | { readonly _tag: 'Encontrada'; readonly operacao: OperacaoRegistrada }
    | { readonly _tag: 'NaoEncontrada' }
    | { readonly _tag: 'Indisponivel' }
  >;
  listarPendentes(scope: VerifiedOrganizationScope): Promise<
    | { readonly _tag: 'Listadas'; readonly operacoes: readonly OperacaoRegistrada[] }
    | { readonly _tag: 'Indisponivel' }
  >;
  registrarReconciliacao(scope: VerifiedOrganizationScope, registro: RegistroDeReconciliacao): Promise<
    | {
        readonly _tag: 'Registrada';
        readonly resultado: 'confirmada' | 'ja_confirmada' | 'revisao_manual' | 'divergente';
        readonly tituloId: string | null;
      }
    | { readonly _tag: 'Indisponivel' }
  >;
  categoriaLocalPorBlingId(scope: VerifiedOrganizationScope, categoriaBlingId: number): Promise<string | null>;
  marcarTituloPago(scope: VerifiedOrganizationScope, tituloId: string): Promise<GravacaoDeTentativa>;
}

/** Dependências da reconciliação. Do Bling, só leitura: nenhum POST é possível daqui. */
export interface ReconciliacaoDependencies {
  readonly operacoes: OperacoesStorePort;
  readonly titulos: Pick<DespesaStorePort, 'salvarTitulo' | 'vincularTitulo'>;
  readonly bling: (scope: VerifiedOrganizationScope) => Pick<BlingPort, 'listarContasPagarParaReconciliacao' | 'lerContaPagarParaReconciliacao'>;
}

/** Resultado de pedir a reconciliação de uma operação. */
export type ResultadoDaReconciliacao =
  | { readonly _tag: 'NaoEncontrada' }
  | { readonly _tag: 'Indisponivel' }
  | {
      readonly _tag: 'Reconciliada';
      readonly resultado: 'confirmada' | 'ja_confirmada' | 'revisao_manual' | 'divergente' | 'nada_pendente';
      readonly motivo: MotivoDeRevisaoManual | null;
      readonly operacao: OperacaoRegistrada;
    };

const PENDENTE = new Set(['em_voo', 'indeterminada']);

/** Lê a listagem e os candidatos por id; decide a criação. Só leitura. */
async function provarCriacao(
  operacao: OperacaoRegistrada,
  bling: Pick<BlingPort, 'listarContasPagarParaReconciliacao' | 'lerContaPagarParaReconciliacao'>,
): Promise<ProvaRemota> {
  const listagem = await bling.listarContasPagarParaReconciliacao({
    dataEmissao: operacao.dataEmissao,
    dataVencimento: operacao.dataVencimento,
    contatoId: operacao.contatoBlingId,
  });
  const triagem = triarListagem(operacao, listagem);
  if (triagem._tag !== 'LerCandidatos') return triagem;
  const leituras = [];
  for (const candidato of triagem.candidatos) {
    leituras.push(await bling.lerContaPagarParaReconciliacao(candidato.id));
  }
  return decidirCriacao(operacao, leituras);
}

/**
 * Título local de uma conta confirmada por reconciliação, a partir do que o
 * Bling tem: o pedido original não é guardado (só o digest dele).
 */
async function gravarTituloDaConta(
  scope: VerifiedOrganizationScope,
  operacao: OperacaoRegistrada,
  conta: ContaPagarDetalhada,
  deps: ReconciliacaoDependencies,
): Promise<void> {
  try {
    const categoriaId = conta.categoriaId === null
      ? null
      : await deps.operacoes.categoriaLocalPorBlingId(scope, conta.categoriaId);
    const titulo = await deps.titulos.salvarTitulo(scope, {
      blingId: conta.id,
      valor: conta.valor,
      dataVencimento: conta.vencimento,
      descricao: conta.historico?.trim() || `Conta a pagar ${conta.id} conciliada com o Bling`,
      ...(categoriaId === null ? {} : { categoriaId }),
      fornecedorBlingId: conta.contatoId,
      situacao: projetarSituacaoDaConta(conta.situacao),
    });
    // Compare-and-set: duas reconciliações gravam o mesmo título (upsert por
    // conta remota) e só uma vincula.
    await deps.titulos.vincularTitulo(scope, operacao.tentativaId, titulo.id);
  } catch (erro: unknown) {
    // A confirmação já está gravada; a próxima conferência refaz só o título.
    registrarFalhaInterna('financeiro.reconciliacao.titulo', erro);
  }
}

function registrarEvento(
  evento: string,
  scope: VerifiedOrganizationScope,
  operacao: OperacaoRegistrada,
  correlationId: string,
  detalhes: Readonly<Record<string, string | number | null>>,
): void {
  logger[evento.endsWith('manual_review') ? 'warn' : 'info'](evento, {
    subsystem: 'app',
    correlationId,
    organizacaoId: scope.organizationId,
    actorId: scope.actorId,
    operacao: operacao.ref,
    ...detalhes,
  });
}

/**
 * Concilia uma operação pendente com o Bling, sem nunca repetir criação ou
 * baixa: o Bling só é lido. Prova inequívoca confirma; todo o resto vira
 * revisão manual, com recibo.
 *
 * @param scope - Organização e ator verificados no servidor.
 * @param ref - A `operation_ref`; sozinha não dá acesso — a leitura filtra a organização.
 * @param correlationId - Correlação da requisição.
 * @param deps - Portas.
 * @returns O desfecho e a operação como ficou.
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

  const alvo = PENDENTE.has(operacao.estado)
    ? 'criacao'
    : operacao.estado === 'confirmada' && operacao.baixa !== null && PENDENTE.has(operacao.baixa.estado)
      ? 'baixa'
      : null;
  if (alvo === null) return { _tag: 'Reconciliada', resultado: 'nada_pendente', motivo: null, operacao };

  registrarEvento('financeiro.reconciliacao.iniciada', scope, operacao, correlationId, { alvo });
  const bling = deps.bling(scope);
  const prova = alvo === 'criacao'
    ? await provarCriacao(operacao, bling)
    : decidirBaixa(operacao.baixa?.blingContaId ?? '', await bling.lerContaPagarParaReconciliacao(operacao.baixa?.blingContaId ?? ''));

  const registro = await deps.operacoes.registrarReconciliacao(scope, {
    ref,
    alvo,
    correlationId,
    metodo: alvo === 'baixa' ? 'leitura_por_id' : operacao.numeroDocumento ? 'referencia_no_numero_documento' : 'sem_metodo_seguro',
    prova,
  });
  if (registro._tag !== 'Registrada') return { _tag: 'Indisponivel' };

  const confirmou = registro.resultado === 'confirmada' || registro.resultado === 'ja_confirmada';
  if (confirmou && prova._tag === 'Comprovada') {
    if (alvo === 'criacao' && registro.tituloId === null) await gravarTituloDaConta(scope, operacao, prova.conta, deps);
    if (alvo === 'baixa' && registro.tituloId !== null) await deps.operacoes.marcarTituloPago(scope, registro.tituloId);
  }

  const evento = prova._tag === 'RevisaoManual'
    ? 'financeiro.reconciliacao.manual_review'
    : alvo === 'baixa' ? 'financeiro.baixa.reconciliada' : 'financeiro.reconciliacao.confirmada';
  registrarEvento(evento, scope, operacao, correlationId, {
    alvo,
    resultado: registro.resultado,
    motivo: prova._tag === 'RevisaoManual' ? prova.motivo : null,
    candidatos: prova.candidatos,
  });

  const relida = await deps.operacoes.lerOperacao(scope, ref);
  return {
    _tag: 'Reconciliada',
    resultado: registro.resultado,
    motivo: prova._tag === 'RevisaoManual' ? prova.motivo : null,
    operacao: relida._tag === 'Encontrada' ? relida.operacao : operacao,
  };
}
