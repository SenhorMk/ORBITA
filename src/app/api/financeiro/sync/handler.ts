import { NextResponse } from 'next/server';

import { descreverErro } from '@/lib/erroLegivel';
import { logger, sanitizeErrorForLog } from '@/lib/observability/logger';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import type { TituloFinanceiro } from '@/types';

import type {
  EntidadeFinanceira,
  FinanceiroSyncBlingPort,
  FinanceiroSyncDependencies,
  FinanceiroSyncResponseBody,
  FinanceiroSyncStorePort,
  RawContaFinanceira,
  SyncStats,
} from './ports';

export type {
  EntidadeFinanceira,
  FinanceiroSyncAuthPort,
  FinanceiroSyncBlingPort,
  FinanceiroSyncDependencies,
  FinanceiroSyncResponseBody,
  FinanceiroSyncStorePort,
  RawContaFinanceira,
  SyncStats,
} from './ports';

const LIMITE_POR_PAGINA = 100;
const MAX_PAGINAS_PADRAO = 50;

function json(body: FinanceiroSyncResponseBody, status: number): NextResponse {
  return NextResponse.json(body, { status });
}

/** 1 = Aberto, 2 = Pago, 3 = Cancelado (padrão Bling). */
function mapSituacao(idSituacao: number): 'aberto' | 'pago' | 'cancelado' {
  if (idSituacao === 1) return 'aberto';
  if (idSituacao === 2) return 'pago';
  if (idSituacao === 3) return 'cancelado';
  return 'aberto';
}

/**
 * Classifica a falha de um item como temporária (rede, timeout,
 * indisponibilidade — reprocessar adianta) ou permanente (dado inválido —
 * reprocessar não adianta).
 */
function ehFalhaTemporaria(err: unknown): boolean {
  return /timeout|network|ECONNRESET|ETIMEDOUT|fetch failed|503|502|504|429/i.test(descreverErro(err));
}

/**
 * Registra a falha no servidor sem carregar nada que não possa ser lido depois.
 *
 * Nunca inclui o item: uma conta carrega valor, vencimento e histórico — dado
 * do negócio do lojista. O que fica é onde falhou e qual entidade.
 */
function registrarFalha(
  erro: unknown,
  contexto: { readonly etapa: string; readonly entidade: EntidadeFinanceira; readonly organizacaoId?: string; readonly blingId?: string },
): void {
  logger.error('Falha na sincronização financeira', {
    subsystem: 'provider',
    operacao: `financeiro.sync.${contexto.etapa}`,
    entidade: contexto.entidade,
    organizacaoId: contexto.organizacaoId,
    blingId: contexto.blingId,
    erro: sanitizeErrorForLog(erro).name,
  });
}

function toTitulo(raw: RawContaFinanceira, tipo: 'pagar' | 'receber'): TituloFinanceiro {
  const rotulo = tipo === 'pagar' ? 'Conta a Pagar' : 'Conta a Receber';
  return {
    bling_id: Number(raw.id),
    tipo,
    situacao: mapSituacao(Number(raw.situacao)),
    valor: Number(raw.valor),
    data_vencimento: String(raw.vencimento),
    data_pagamento: raw.pagamento?.data || undefined,
    descricao: raw.historico || `${rotulo} #${raw.id}`,
  };
}

/**
 * Sincroniza uma entidade financeira inteira, página a página.
 *
 * O que mudou em relação à versão anterior, e por quê:
 *
 * - **a leitura pode falhar, e a falha para o laço.** Antes o cliente devolvia
 *   `[]` em 401/403/500/timeout, o laço interpretava como fim dos dados e a
 *   etapa terminava "com sucesso" tendo processado zero;
 * - **o checkpoint só avança se todas as páginas foram lidas.** Marcar depois
 *   de uma leitura falha registra um progresso que não houve;
 * - **falha de item não é mais só um `console.warn`.** Continua não derrubando
 *   o lote — um dado inválido não pode impedir os outros — mas entra na
 *   contagem que a resposta carrega.
 */
async function sincronizarEntidade(
  scope: VerifiedOrganizationScope,
  entidade: EntidadeFinanceira,
  tipo: 'pagar' | 'receber',
  store: FinanceiroSyncStorePort,
  bling: FinanceiroSyncBlingPort,
  maxPaginas: number,
): Promise<SyncStats> {
  let processados = 0;
  let falhasTemporarias = 0;
  let falhasPermanentes = 0;

  for (let pagina = 1; pagina <= maxPaginas; pagina++) {
    let itens: readonly RawContaFinanceira[];
    try {
      itens = await bling.lerPagina(entidade, pagina, LIMITE_POR_PAGINA);
    } catch (err: unknown) {
      registrarFalha(err, { etapa: 'ler-pagina', entidade, organizacaoId: scope.organizationId });
      // Sai sem marcar checkpoint: o que veio até aqui é parcial e assumido.
      return { processados, falhasTemporarias, falhasPermanentes, leituraFalhou: true };
    }

    if (itens.length === 0) break;

    for (const raw of itens) {
      try {
        // Idempotente: `onConflict (organizacao_id, bling_id)` no repositório
        // faz a reexecução atualizar o mesmo registro, nunca duplicar.
        await store.upsertTitulo(scope, toTitulo(raw, tipo));
        processados++;
      } catch (err: unknown) {
        if (ehFalhaTemporaria(err)) falhasTemporarias++;
        else falhasPermanentes++;
        registrarFalha(err, {
          etapa: 'gravar-titulo',
          entidade,
          organizacaoId: scope.organizationId,
          blingId: raw.id === undefined ? undefined : String(raw.id),
        });
      }
    }

    if (itens.length < LIMITE_POR_PAGINA) break;
  }

  await store.marcarCheckpoint(scope, entidade);
  return { processados, falhasTemporarias, falhasPermanentes, leituraFalhou: false };
}

/**
 * Sincroniza contas a pagar e a receber do Bling para a organização verificada.
 *
 * A resposta só diz `success: true` quando nenhuma leitura falhou e nenhum item
 * ficou para trás em definitivo. Um `success` que ignora falhas foi a quarta
 * das cinco camadas que esconderam a quebra do catálogo.
 */
export function createFinanceiroSyncHandler(deps: FinanceiroSyncDependencies) {
  const { auth, store, bling } = deps;
  const maxPaginas = deps.maxPaginas ?? MAX_PAGINAS_PADRAO;

  return async function handleFinanceiroSync(request: Request): Promise<NextResponse> {
    let organizacaoId: string | undefined;
    try {
      const ator = await auth.authenticate(request);
      if (!ator) return json({ success: false, error: 'Não autorizado' }, 401);

      const scopeResult = await auth.resolveScope(request);
      if (scopeResult._tag !== 'Resolved') return scopeResult.response;
      const { scope } = scopeResult;
      organizacaoId = scope.organizationId;

      const contasPagar = await sincronizarEntidade(scope, 'financeiro_contas_pagar', 'pagar', store, bling, maxPaginas);
      const contasReceber = await sincronizarEntidade(scope, 'financeiro_contas_receber', 'receber', store, bling, maxPaginas);

      const stats = { contasPagar, contasReceber };
      const leituraFalhou = contasPagar.leituraFalhou || contasReceber.leituraFalhou;
      const itensPerdidos = contasPagar.falhasPermanentes + contasReceber.falhasPermanentes
        + contasPagar.falhasTemporarias + contasReceber.falhasTemporarias;

      if (leituraFalhou) {
        // 502: o provedor não respondeu o que devia. A mensagem nomeia a etapa
        // sem repassar nada do erro dele — o diagnóstico ficou no log.
        return json(
          { success: false, error: 'Não foi possível ler as contas no Bling; a sincronização ficou incompleta.', stats },
          502,
        );
      }

      if (itensPerdidos > 0) {
        return json(
          { success: false, error: `${itensPerdidos} título(s) não puderam ser gravados.`, stats },
          200,
        );
      }

      return json({ success: true, stats }, 200);
    } catch (error: unknown) {
      // CWE-209: o diagnóstico fica no servidor, o cliente recebe a frase fixa.
      logger.error('Falha na sincronização financeira', {
        subsystem: 'app',
        operacao: 'financeiro.sync',
        organizacaoId,
        erro: sanitizeErrorForLog(error).name,
      });
      return json({ success: false, error: 'Erro interno' }, 500);
    }
  };
}
