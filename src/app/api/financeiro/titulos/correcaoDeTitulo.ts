import { NextResponse } from 'next/server';
import { z } from 'zod';

import {
  STATUS_HTTP_DA_CORRECAO,
  type RespostaDeCorrecao,
} from '@/lib/config/correcaoOperacionalContract';
import type { ExclusaoRemota, LeituraRemota } from '@/lib/integrations/bling/operacaoRemotaContract';
import { SITUACAO_DA_CONTA_BLING } from '@/lib/integrations/bling/situacaoDaContaBling';
import { movimentacaoContaComoAtiva } from '@/lib/metricas/movimentacaoAtiva';
import { registrarFalhaInterna } from '@/lib/observability/falhaInterna';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import type { ContaPagarRemota } from '@/services/blingPort';
import { excluirComConfirmacao } from '@/services/exclusaoRemotaConfirmada';

/**
 * Correção de um lançamento de despesa errado. Duas ações, nunca um `DELETE`
 * genérico de título:
 *
 * - **excluir lançamento** (`POST /api/financeiro/titulos/{id}/exclusao`): só a
 *   despesa puramente interna — `pagar`, sem `bling_id`, sem `pedido_id`. Aberta
 *   ou paga: aqui "paga" é só uma marcação local, e a correção de uma entrada
 *   manual errada remove a linha de vez;
 * - **cancelar despesa** (`POST /api/financeiro/titulos/{id}/cancelamento`): só a
 *   despesa do Bling. A situação **real** é lida no Bling antes de agir; a
 *   situação local não é autoridade. Com ausência remota confirmada o título
 *   vira `cancelado` e **continua** no histórico.
 *
 * O navegador manda só o id local, na URL. O `bling_id` usado é o gravado no
 * título carregado por `id` + organização do escopo.
 *
 * | Situação no Bling (`GET`)  | Resultado                                                     |
 * |----------------------------|---------------------------------------------------------------|
 * | `1` Aberto                 | `DELETE`, confirmado → `cancelado`                            |
 * | `5` Cancelado, ou `404`    | converge para `cancelado` **sem** novo `DELETE`               |
 * | `2` Pago                   | `Blocked` — estorno automático não é suportado com segurança  |
 * | `3`, `4`, `6`, `7`         | `Blocked` — o contrato não prova que cancelar seja seguro     |
 * | leitura sem prova          | `ReconcileRequired` — nada local muda                         |
 *
 * Nenhum borderô é tocado, e nada vira `estornado` por aqui.
 */

export interface TituloParaCorrecao {
  readonly id: string;
  readonly tipo: string;
  readonly situacao: string;
  readonly blingId: string | null;
  readonly pedidoId: string | null;
}

export interface CorrecaoDeTituloStorePort {
  carregarTituloParaCorrecao(scope: VerifiedOrganizationScope, id: string): Promise<TituloParaCorrecao | null>;
  excluirLancamentoInterno(scope: VerifiedOrganizationScope, id: string): Promise<number>;
  marcarDespesaCancelada(scope: VerifiedOrganizationScope, id: string): Promise<number>;
}

export interface ContaPagarNoBlingPort {
  consultarContaPagar(id: string): Promise<LeituraRemota<ContaPagarRemota>>;
  excluirContaPagar(id: string): Promise<ExclusaoRemota>;
}

export interface EventoDeAuditoriaFinanceira {
  readonly acao: 'finance.entry_deleted' | 'finance.expense_cancelled' | 'finance.remote_reconcile_required';
  readonly recurso: 'titulo_financeiro';
  readonly recursoId: string;
  readonly correlationId: string;
  readonly metadata: Readonly<Record<string, string | boolean>>;
}

export interface CorrecaoDeTituloDependencies {
  readonly autorizar: (request: Request) => Promise<
    | { readonly _tag: 'Autorizado'; readonly scope: VerifiedOrganizationScope }
    | { readonly _tag: 'Negado'; readonly response: NextResponse }
  >;
  readonly store: CorrecaoDeTituloStorePort;
  readonly bling: (scope: VerifiedOrganizationScope) => ContaPagarNoBlingPort;
  readonly auditar: (scope: VerifiedOrganizationScope, evento: EventoDeAuditoriaFinanceira) => Promise<void>;
  readonly correlationId: (request: Request) => string;
}

const idSchema = z.string().uuid();

function responder(corpo: RespostaDeCorrecao): NextResponse {
  return NextResponse.json(corpo, { status: STATUS_HTTP_DA_CORRECAO[corpo.resultado] });
}

async function auditarSemInterromper(
  deps: CorrecaoDeTituloDependencies,
  scope: VerifiedOrganizationScope,
  evento: EventoDeAuditoriaFinanceira,
): Promise<void> {
  try {
    await deps.auditar(scope, evento);
  } catch (erro: unknown) {
    // O efeito já aconteceu (ou, no caso da reconciliação, nada aconteceu):
    // a falha da trilha não muda a resposta, e fica no log do servidor.
    registrarFalhaInterna(`financeiro.correcao.auditoria.${evento.acao}`, erro, { organizacaoId: scope.organizationId });
  }
}

/**
 * As regras estruturais comuns às duas ações, sobre o título **como ele está**.
 * `null` = o título segue elegível. Usada na preparação e de novo quando a
 * escrita não pegou linha nenhuma, para dizer o que mudou em vez de supor.
 */
function impedimentoComum(titulo: TituloParaCorrecao): RespostaDeCorrecao | null {
  if (titulo.tipo !== 'pagar') return { resultado: 'Blocked', motivo: 'nao_e_despesa' };
  if (titulo.pedidoId !== null) return { resultado: 'Blocked', motivo: 'vinculado_a_pedido' };
  if (!movimentacaoContaComoAtiva(titulo.situacao)) return { resultado: 'AlreadyTerminal' };
  return null;
}

/** O que impede excluir como lançamento interno — as comuns, mais não ser do Bling. */
function impedimentoDaExclusaoInterna(titulo: TituloParaCorrecao): RespostaDeCorrecao | null {
  return impedimentoComum(titulo)
    ?? (titulo.blingId !== null ? { resultado: 'Blocked', motivo: 'despesa_do_bling' } : null);
}

/** Autoriza, valida o id e carrega o título do escopo — comum às duas ações. */
async function prepararCorrecao(
  deps: CorrecaoDeTituloDependencies,
  request: Request,
  idBruto: string,
): Promise<
  | { readonly _tag: 'Resposta'; readonly response: NextResponse }
  | { readonly _tag: 'Pronto'; readonly scope: VerifiedOrganizationScope; readonly titulo: TituloParaCorrecao }
> {
  const autorizacao = await deps.autorizar(request);
  if (autorizacao._tag === 'Negado') return { _tag: 'Resposta', response: autorizacao.response };
  const { scope } = autorizacao;

  const id = idSchema.safeParse(idBruto);
  if (!id.success) return { _tag: 'Resposta', response: responder({ resultado: 'InvalidRequest' }) };

  const titulo = await deps.store.carregarTituloParaCorrecao(scope, id.data);
  if (!titulo) return { _tag: 'Resposta', response: responder({ resultado: 'NotFound' }) };
  const impedimento = impedimentoComum(titulo);
  if (impedimento) return { _tag: 'Resposta', response: responder(impedimento) };
  return { _tag: 'Pronto', scope, titulo };
}

export function createExclusaoDeLancamentoHandler(deps: CorrecaoDeTituloDependencies) {
  return async function excluirLancamento(request: Request, idBruto: string): Promise<NextResponse> {
    const preparo = await prepararCorrecao(deps, request, idBruto);
    if (preparo._tag === 'Resposta') return preparo.response;
    const { scope, titulo } = preparo;

    const impedimento = impedimentoDaExclusaoInterna(titulo);
    if (impedimento) return responder(impedimento);

    const removidas = await deps.store.excluirLancamentoInterno(scope, titulo.id);
    if (removidas !== 1) {
      // O `DELETE` repete todas as condições — inclusive a situação ativa —, e
      // nada saiu: o título mudou desde a leitura. Zero linhas não vira
      // `NotFound` por conta própria: a resposta é o estado de agora.
      const atual = await deps.store.carregarTituloParaCorrecao(scope, titulo.id);
      if (!atual) return responder({ resultado: 'NotFound' });
      const agora = impedimentoDaExclusaoInterna(atual);
      if (agora) return responder(agora);
      // Elegível e mesmo assim intocado: nada explica isso. Falhar alto (500
      // genérico na rota) em vez de inventar um desfecho.
      throw new Error('Despesa interna elegível não foi removida pelo DELETE condicional.');
    }

    await auditarSemInterromper(deps, scope, {
      acao: 'finance.entry_deleted',
      recurso: 'titulo_financeiro',
      recursoId: titulo.id,
      correlationId: deps.correlationId(request),
      metadata: { situacao_anterior: titulo.situacao, origem: 'interno' },
    });
    return responder({ resultado: 'Deleted', removidoDoBling: false });
  };
}

/** O que provou que a conta não está mais ativa no Bling. */
type Evidencia = 'remoto_ausente' | 'remoto_cancelado' | 'exclusao_confirmada';

type PassoDoCancelamento =
  | { readonly _tag: 'Evidencia'; readonly evidencia: Evidencia }
  | { readonly _tag: 'Resposta'; readonly corpo: RespostaDeCorrecao }
  | { readonly _tag: 'Indeterminado'; readonly operacao: 'consultar' | 'excluir' };

const RECUSA_DO_BLING = { _tag: 'Resposta', corpo: { resultado: 'ProviderRefused', motivo: 'recusado_pelo_bling' } } as const;
const LIMITE_DO_BLING = { _tag: 'Resposta', corpo: { resultado: 'ProviderRefused', motivo: 'limite_de_requisicoes' } } as const;

/**
 * Lê a conta no Bling e decide pelo que ela **é agora**. Só `1` Aberto leva
 * ao `DELETE`; `5` e `404` já são a evidência; o resto bloqueia.
 */
async function provarAusenciaRemota(porta: ContaPagarNoBlingPort, blingId: string): Promise<PassoDoCancelamento> {
  const leitura = await porta.consultarContaPagar(blingId);
  switch (leitura._tag) {
    case 'RemotoRecusou':
      return RECUSA_DO_BLING;
    case 'RemotoLimitado':
      return LIMITE_DO_BLING;
    case 'RemotoIndeterminado':
      return { _tag: 'Indeterminado', operacao: 'consultar' };
    case 'RemotoAusente':
      return { _tag: 'Evidencia', evidencia: 'remoto_ausente' };
    case 'RemotoPresente':
      break;
  }

  const situacao = leitura.valor.situacao;
  if (situacao === SITUACAO_DA_CONTA_BLING.cancelado) return { _tag: 'Evidencia', evidencia: 'remoto_cancelado' };
  if (situacao === SITUACAO_DA_CONTA_BLING.pago) {
    return { _tag: 'Resposta', corpo: { resultado: 'Blocked', motivo: 'estorno_nao_suportado_com_seguranca' } };
  }
  if (situacao !== SITUACAO_DA_CONTA_BLING.aberto) {
    return { _tag: 'Resposta', corpo: { resultado: 'Blocked', motivo: 'situacao_remota_impede_cancelamento' } };
  }

  const desfecho = await excluirComConfirmacao({
    excluir: () => porta.excluirContaPagar(blingId),
    consultar: () => porta.consultarContaPagar(blingId),
  });
  switch (desfecho._tag) {
    case 'AusenciaConfirmada':
      return { _tag: 'Evidencia', evidencia: 'exclusao_confirmada' };
    case 'Recusada':
      return RECUSA_DO_BLING;
    case 'Limitada':
      return LIMITE_DO_BLING;
    case 'RemotoAindaExiste':
      return { _tag: 'Resposta', corpo: { resultado: 'ProviderRefused', motivo: 'exclusao_nao_confirmada' } };
    case 'Indeterminada':
      return { _tag: 'Indeterminado', operacao: 'excluir' };
  }
}

/** Com a ausência remota provada, leva o título a `cancelado` — e só ele. */
async function concluirCancelamento(
  deps: CorrecaoDeTituloDependencies,
  scope: VerifiedOrganizationScope,
  titulo: TituloParaCorrecao & { readonly blingId: string },
  evidencia: Evidencia,
  correlationId: string,
): Promise<NextResponse> {
  let alteradas: number;
  try {
    alteradas = await deps.store.marcarDespesaCancelada(scope, titulo.id);
  } catch (erro: unknown) {
    registrarFalhaInterna('financeiro.cancelar.local', erro, { organizacaoId: scope.organizationId });
    // A ausência no Bling já está provada. Repetir é seguro: a próxima
    // tentativa lê `404` e converge, sem novo `DELETE`.
    return responder({ resultado: 'ReconcileRequired', motivo: 'conclusao_local_pendente' });
  }

  if (alteradas !== 1) {
    // Outra requisição (ou o cancelamento do pedido) chegou antes. Conferir
    // o estado atual em vez de afirmar sucesso por esta.
    const atual = await deps.store.carregarTituloParaCorrecao(scope, titulo.id);
    if (atual && !movimentacaoContaComoAtiva(atual.situacao)) return responder({ resultado: 'AlreadyTerminal' });
    return responder({ resultado: 'NotFound' });
  }

  await auditarSemInterromper(deps, scope, {
    acao: 'finance.expense_cancelled',
    recurso: 'titulo_financeiro',
    recursoId: titulo.id,
    correlationId,
    metadata: { bling_id: titulo.blingId, evidencia, situacao_anterior: titulo.situacao },
  });
  return responder({ resultado: 'Cancelled' });
}

export function createCancelamentoDeDespesaHandler(deps: CorrecaoDeTituloDependencies) {
  return async function cancelarDespesa(request: Request, idBruto: string): Promise<NextResponse> {
    const preparo = await prepararCorrecao(deps, request, idBruto);
    if (preparo._tag === 'Resposta') return preparo.response;
    const { scope, titulo } = preparo;

    const blingId = titulo.blingId;
    if (blingId === null || !/^\d+$/u.test(blingId)) {
      return responder({ resultado: 'Blocked', motivo: 'despesa_interna' });
    }
    const correlationId = deps.correlationId(request);

    // A situação local não é autoridade: o que o Bling diz agora é.
    const passo = await provarAusenciaRemota(deps.bling(scope), blingId);
    if (passo._tag === 'Resposta') return responder(passo.corpo);
    if (passo._tag === 'Indeterminado') {
      await auditarSemInterromper(deps, scope, {
        acao: 'finance.remote_reconcile_required',
        recurso: 'titulo_financeiro',
        recursoId: titulo.id,
        correlationId,
        metadata: { bling_id: blingId, operacao: `cancelar_despesa.${passo.operacao}`, estado_remoto: 'indeterminado' },
      });
      return responder({ resultado: 'ReconcileRequired', motivo: 'estado_remoto_indeterminado' });
    }

    return concluirCancelamento(deps, scope, { ...titulo, blingId }, passo.evidencia, correlationId);
  };
}
