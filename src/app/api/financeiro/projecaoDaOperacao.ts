import { logger } from '@/lib/observability/logger';
import { registrarFalhaInterna } from '@/lib/observability/falhaInterna';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import type { ContaPagarDetalhada } from '@/services/blingPort';

import type { LeiturasDoBling, OperacaoRegistrada, ReconciliacaoDependencies } from './reconciliacaoDaOperacao';
import {
  decidirAutoriaDaBaixa,
  decidirCriacao,
  pendenciaDaOperacao,
  situacaoLocalComprovada,
  triarContaDaBaixa,
  triarListagem,
  type PendenciaDaOperacao,
  type ProvaRemota,
} from './reconciliacaoDeContaPagar';
import { referenciaDaBaixa } from './tentativaDeContaPagar';

/**
 * As leituras do Bling e a projeção local que a reconciliação usa (PRE-002):
 * provar criação e baixa (só leitura), regravar o título pela conta lida e
 * reler a operação para dizer se a projeção ficou consistente.
 */

const REPAROS: ReadonlySet<PendenciaDaOperacao | null> = new Set(['reparo_titulo', 'reparo_titulo_pago', 'titulo_inconsistente']);

/** Relê a operação e diz se a projeção local ficou consistente — o estado gravado decide, não o retorno de cada passo. */
export async function fechar(
  scope: VerifiedOrganizationScope,
  ref: string,
  original: OperacaoRegistrada,
  deps: ReconciliacaoDependencies,
): Promise<{ readonly operacao: OperacaoRegistrada; readonly projecaoLocal: 'consistente' | 'pendente' }> {
  const relida = await deps.operacoes.lerOperacao(scope, ref);
  if (relida._tag !== 'Encontrada') return { operacao: original, projecaoLocal: 'pendente' };
  return { operacao: relida.operacao, projecaoLocal: REPAROS.has(pendenciaDaOperacao(relida.operacao)) ? 'pendente' : 'consistente' };
}

/** Lê a listagem e os candidatos por id; decide a criação. Só leitura. */
export async function provarCriacao(operacao: OperacaoRegistrada, bling: LeiturasDoBling): Promise<ProvaRemota> {
  const listagem = await bling.listarContasPagarParaReconciliacao({
    dataEmissao: operacao.dataEmissao,
    dataVencimento: operacao.dataVencimento,
    contatoId: operacao.contatoBlingId,
  });
  const triagem = triarListagem(operacao, listagem);
  if (triagem._tag !== 'LerCandidatos') return triagem;
  const leituras = [];
  for (const candidato of triagem.candidatos) leituras.push(await bling.lerContaPagarParaReconciliacao(candidato.id));
  return decidirCriacao(operacao, leituras);
}

/** Lê a conta e seus borderôs; decide se a baixa do ORBITA quitou a conta. Só leitura. */
export async function provarBaixa(baixa: NonNullable<OperacaoRegistrada['baixa']>, bling: LeiturasDoBling): Promise<ProvaRemota> {
  const triagem = triarContaDaBaixa(baixa.blingContaId, await bling.lerContaPagarParaReconciliacao(baixa.blingContaId));
  if (triagem._tag !== 'LerBorderos') return triagem;
  const leituras = [];
  for (const id of triagem.conta.borderos) leituras.push(await bling.lerBorderoParaReconciliacao(id));
  return decidirAutoriaDaBaixa({ referencia: referenciaDaBaixa(baixa.id), dataBaixa: baixa.dataBaixa }, triagem.conta, leituras);
}

/**
 * Título local de uma conta confirmada, a partir do que o Bling tem. Upsert pela
 * conta remota e vínculo por CAS: chamar de novo grava o MESMO título e não cria
 * outro. Falha não é engolida em silêncio: o estado relido decide a projeção.
 */
export async function gravarTituloDaConta(
  scope: VerifiedOrganizationScope,
  operacao: OperacaoRegistrada,
  conta: ContaPagarDetalhada,
  deps: ReconciliacaoDependencies,
): Promise<void> {
  try {
    const categoriaId = conta.categoriaId === null ? null : await deps.operacoes.categoriaLocalPorBlingId(scope, conta.categoriaId);
    const titulo = await deps.titulos.salvarTitulo(scope, {
      blingId: conta.id,
      valor: conta.valor,
      dataVencimento: conta.vencimento,
      descricao: conta.historico?.trim() || `Conta a pagar ${conta.id} conciliada com o Bling`,
      ...(categoriaId === null ? {} : { categoriaId }),
      fornecedorBlingId: conta.contatoId,
      situacao: situacaoLocalComprovada(conta),
      // Guarda o que o Bling disse: `Pago` sem saldo comprovado deixa o título
      // aberto e a divergência visível (`pagamento_nao_comprovado`).
      situacaoBling: conta.situacao,
    });
    if (operacao.tituloId === titulo.id) return;
    if (await deps.titulos.vincularTitulo(scope, operacao.tentativaId, titulo.id) === 'NaoGravado') {
      registrarFalhaInterna('financeiro.reconciliacao.titulo.vincular', new Error('vínculo não gravado'));
    }
  } catch (erro: unknown) {
    registrarFalhaInterna('financeiro.reconciliacao.titulo', erro);
  }
}

export function registrarEvento(
  evento: string,
  scope: VerifiedOrganizationScope,
  operacao: OperacaoRegistrada,
  correlationId: string,
  detalhes: Readonly<Record<string, string | number | null>>,
): void {
  logger[evento.endsWith('manual_review') || evento.endsWith('pendente') ? 'warn' : 'info'](evento, {
    subsystem: 'app', correlationId, organizacaoId: scope.organizationId, actorId: scope.actorId, operacao: operacao.ref, ...detalhes,
  });
}
