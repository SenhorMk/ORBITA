import { NextResponse } from 'next/server';
import { bling } from '@/services/bling';
import { financeiroRepository } from '@/repositories/financeiroRepository';
import { verifySessionAndRole } from '@/lib/auth';
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

async function syncContasPagar(client: ReturnType<typeof bling.forUser>, tenant: Parameters<typeof financeiroRepository.upsertTitulo>[0]): Promise<number> {
  let count = 0;
  let page = 1;
  while (page <= 50) {
    const contasPagar: RawContaFinanceira[] = (await client.getContasPagar(page, 100)) as RawContaFinanceira[];
    if (contasPagar.length === 0) break;

    for (const cp of contasPagar) {
      try {
        const titulo: TituloFinanceiro = {
          bling_id: Number(cp.id),
          tipo: 'pagar',
          situacao: mapSituacao(Number(cp.situacao)),
          valor: Number(cp.valor),
          data_vencimento: String(cp.vencimento),
          data_pagamento: cp.pagamento?.data || undefined,
          descricao: cp.historico || `Conta a Pagar #${cp.id}`,
        };
        await financeiroRepository.upsertTitulo(tenant, titulo);
        count++;
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.warn(`Erro ao sincronizar Conta a Pagar ${cp.id}:`, errMsg);
      }
    }
    page++;
    if (contasPagar.length < 100) break;
  }
  return count;
}

async function syncContasReceber(client: ReturnType<typeof bling.forUser>, tenant: Parameters<typeof financeiroRepository.upsertTitulo>[0]): Promise<number> {
  let count = 0;
  let page = 1;
  while (page <= 50) {
    const contasReceber: RawContaFinanceira[] = (await client.getContasReceber(page, 100)) as RawContaFinanceira[];
    if (contasReceber.length === 0) break;

    for (const cr of contasReceber) {
      try {
        const titulo: TituloFinanceiro = {
          bling_id: Number(cr.id),
          tipo: 'receber',
          situacao: mapSituacao(Number(cr.situacao)),
          valor: Number(cr.valor),
          data_vencimento: String(cr.vencimento),
          data_pagamento: cr.pagamento?.data || undefined,
          descricao: cr.historico || `Conta a Receber #${cr.id}`,
        };
        await financeiroRepository.upsertTitulo(tenant, titulo);
        count++;
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.warn(`Erro ao sincronizar Conta a Receber ${cr.id}:`, errMsg);
      }
    }
    page++;
    if (contasReceber.length < 100) break;
  }
  return count;
}

export async function POST(request: Request) {
  try {
    const session = await verifySessionAndRole(request);
    if (!session) {
      return NextResponse.json({ success: false, error: 'Não autorizado' }, { status: 401 });
    }
    const blingClient = bling.forUser(session.tenant);

    const contasPagar = await syncContasPagar(blingClient, session.tenant);
    const contasReceber = await syncContasReceber(blingClient, session.tenant);

    return NextResponse.json({
      success: true,
      stats: { contasPagar, contasReceber }
    });
  } catch (error: unknown) {
    console.error('Erro na API de Sincronização Financeira:', error);
    const errMsg = error instanceof Error ? error.message : 'Erro interno na sincronização financeira';
    return NextResponse.json(
      { success: false, error: errMsg },
      { status: 500 }
    );
  }
}
