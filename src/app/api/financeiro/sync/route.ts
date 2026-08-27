import { NextResponse } from 'next/server';
import { bling } from '@/services/bling';
import { financeiroRepository } from '@/repositories/financeiroRepository';
import { verifySessionAndRole } from '@/lib/auth';
import { resolveVerifiedOrganizationScope } from '@/lib/requestOrganizationContext';
import { supabaseServer } from '@/lib/supabaseServer';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import { TituloFinanceiro } from '@/types';

export const dynamic = 'force-dynamic';

function mapSituacao(idSituacao: number): 'aberto' | 'pago' | 'cancelado' {
  // 1 = Aberto, 2 = Pago, 3 = Cancelado (Padrão Bling)
  if (idSituacao === 1) return 'aberto';
  if (idSituacao === 2) return 'pago';
  if (idSituacao === 3) return 'cancelado';
  return 'aberto'; // fallback
}

interface RawContaFinanceira {
  id?: number | string;
  situacao?: number | string;
  valor?: number | string;
  vencimento?: string;
  pagamento?: { data?: string };
  historico?: string;
}

interface SyncStats {
  processados: number;
  falhasTemporarias: number;
  falhasPermanentes: number;
}

/**
 * Classifica um erro de sincronização como temporário (rede, timeout,
 * indisponibilidade — o item deve ser reprocessado em uma execução futura)
 * ou permanente (dado inválido — reprocessar não ajuda). Nunca registra o
 * payload/valor do item, apenas a classificação e um identificador (bling_id).
 */
function isTemporaryError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /timeout|network|ECONNRESET|ETIMEDOUT|fetch failed|503|502|504|429/i.test(message);
}

/** Checkpoint de sincronização por organização/entidade, reaproveitando sync_state (ver src/services/sync.ts). */
async function touchSyncCheckpoint(organizacaoId: string, entidade: string): Promise<void> {
  const now = new Date().toISOString();
  await supabaseServer
    .from('sync_state')
    .upsert(
      { organizacao_id: organizacaoId, entidade, last_synced_at: now, updated_at: now },
      { onConflict: 'organizacao_id, entidade' },
    );
}

/**
 * Sincroniza uma página paginada de títulos financeiros (contas a pagar ou a
 * receber) do Bling para a organização verificada. Compartilhada pelas duas
 * direções (pagar/receber) para não duplicar o laço de paginação, a
 * classificação de erro e o checkpoint — só o fetch de página e o mapeamento
 * de item variam por direção.
 */
async function syncTitulosFinanceiros(
  scope: VerifiedOrganizationScope,
  entidade: 'financeiro_contas_pagar' | 'financeiro_contas_receber',
  fetchPage: (page: number) => Promise<RawContaFinanceira[]>,
  toTitulo: (raw: RawContaFinanceira) => TituloFinanceiro,
): Promise<SyncStats> {
  const stats: SyncStats = { processados: 0, falhasTemporarias: 0, falhasPermanentes: 0 };
  let page = 1;
  while (page <= 50) {
    const itens = await fetchPage(page);
    if (itens.length === 0) break;

    for (const raw of itens) {
      try {
        const titulo = toTitulo(raw);
        // Idempotente: onConflict (organizacao_id, bling_id) no repository
        // garante que o mesmo evento reprocessado atualiza monotonicamente
        // o mesmo registro, nunca duplica.
        await financeiroRepository.upsertTitulo(scope, titulo);
        stats.processados++;
      } catch (err: unknown) {
        if (isTemporaryError(err)) {
          stats.falhasTemporarias++;
          console.warn(`[financeiro/sync] Falha temporaria ao sincronizar ${entidade} bling_id=${raw.id}`);
        } else {
          stats.falhasPermanentes++;
          console.warn(`[financeiro/sync] Falha permanente ao sincronizar ${entidade} bling_id=${raw.id}`);
        }
      }
    }
    page++;
    if (itens.length < 100) break;
  }
  await touchSyncCheckpoint(scope.organizationId, entidade);
  return stats;
}

function toTituloPagar(cp: RawContaFinanceira): TituloFinanceiro {
  return {
    bling_id: Number(cp.id),
    tipo: 'pagar',
    situacao: mapSituacao(Number(cp.situacao)),
    valor: Number(cp.valor),
    data_vencimento: String(cp.vencimento),
    data_pagamento: cp.pagamento?.data || undefined,
    descricao: cp.historico || `Conta a Pagar #${cp.id}`,
  };
}

function toTituloReceber(cr: RawContaFinanceira): TituloFinanceiro {
  return {
    bling_id: Number(cr.id),
    tipo: 'receber',
    situacao: mapSituacao(Number(cr.situacao)),
    valor: Number(cr.valor),
    data_vencimento: String(cr.vencimento),
    data_pagamento: cr.pagamento?.data || undefined,
    descricao: cr.historico || `Conta a Receber #${cr.id}`,
  };
}

export async function POST(request: Request) {
  try {
    const session = await verifySessionAndRole(request);
    if (!session) {
      return NextResponse.json({ success: false, error: 'Não autorizado' }, { status: 401 });
    }
    const scopeResult = await resolveVerifiedOrganizationScope(request);
    if (scopeResult._tag !== 'RequestScopeResolved') return scopeResult.response;
    const scope = scopeResult.scope;

    const blingClient = bling.forUser(session.tenant);

    const contasPagar = await syncTitulosFinanceiros(
      scope,
      'financeiro_contas_pagar',
      (page) => blingClient.getContasPagar(page, 100) as Promise<RawContaFinanceira[]>,
      toTituloPagar,
    );
    const contasReceber = await syncTitulosFinanceiros(
      scope,
      'financeiro_contas_receber',
      (page) => blingClient.getContasReceber(page, 100) as Promise<RawContaFinanceira[]>,
      toTituloReceber,
    );

    return NextResponse.json({
      success: true,
      stats: { contasPagar, contasReceber }
    });
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : 'Erro interno na sincronização financeira';
    console.error('Erro na API de Sincronização Financeira:', errMsg);
    return NextResponse.json(
      { success: false, error: errMsg },
      { status: 500 }
    );
  }
}
