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

export async function POST(request: Request) {
  try {
    const session = await verifySessionAndRole(request);
    if (!session) {
      return NextResponse.json({ success: false, error: 'Não autorizado' }, { status: 401 });
    }
    const userId = session.user.id;
    const blingClient = bling.forUser(userId);
    
    let stats = {
      contasPagar: 0,
      contasReceber: 0
    };

    // --- 1. SINCRONIZAR CONTAS A PAGAR ---
    let pagePagar = 1;
    while (pagePagar <= 50) {
      const contasPagar = await blingClient.getContasPagar(pagePagar, 100);
      if (contasPagar.length === 0) break;
      
      for (const cp of contasPagar) {
        try {
          const titulo: TituloFinanceiro = {
            bling_id: cp.id,
            tipo: 'pagar',
            situacao: mapSituacao(cp.situacao),
            valor: Number(cp.valor),
            data_vencimento: cp.vencimento,
            data_pagamento: cp.pagamento?.data || undefined,
            descricao: cp.historico || `Conta a Pagar #${cp.id}`,
          };
          
          await financeiroRepository.upsertTitulo(userId, titulo);
          stats.contasPagar++;
        } catch (err: any) {
          console.warn(`Erro ao sincronizar Conta a Pagar ${cp.id}:`, err.message);
        }
      }
      
      pagePagar++;
      if (contasPagar.length < 100) break;
    }

    // --- 2. SINCRONIZAR CONTAS A RECEBER ---
    let pageReceber = 1;
    while (pageReceber <= 50) {
      const contasReceber = await blingClient.getContasReceber(pageReceber, 100);
      if (contasReceber.length === 0) break;
      
      for (const cr of contasReceber) {
        try {
          const titulo: TituloFinanceiro = {
            bling_id: cr.id,
            tipo: 'receber',
            situacao: mapSituacao(cr.situacao),
            valor: Number(cr.valor),
            data_vencimento: cr.vencimento,
            data_pagamento: cr.pagamento?.data || undefined,
            descricao: cr.historico || `Conta a Receber #${cr.id}`,
          };
          
          await financeiroRepository.upsertTitulo(userId, titulo);
          stats.contasReceber++;
        } catch (err: any) {
          console.warn(`Erro ao sincronizar Conta a Receber ${cr.id}:`, err.message);
        }
      }
      
      pageReceber++;
      if (contasReceber.length < 100) break;
    }

    return NextResponse.json({ success: true, stats });
  } catch (error: any) {
    console.error('Erro na API de Sincronização Financeira:', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Erro interno na sincronização financeira' },
      { status: 500 }
    );
  }
}
