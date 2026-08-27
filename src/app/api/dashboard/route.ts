import { NextResponse } from 'next/server';
import { pedidoRepository } from '@/repositories/pedidoRepository';
import { produtoRepository } from '@/repositories/produtoRepository';
import { clienteRepository } from '@/repositories/clienteRepository';
import { supabaseServer } from '@/lib/supabaseServer';
import { resolveVerifiedOrganizationScope } from '@/lib/requestOrganizationContext';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const scopeResult = await resolveVerifiedOrganizationScope(request);
    if (scopeResult._tag !== 'RequestScopeResolved') return scopeResult.response;
    const scope = scopeResult.scope;

    let stats = { faturamento30: 0, total: 0, pendentes: 0, cancelados: 0, atendidos: 0 };
    let pedidos: unknown[] = [];
    let produtos: unknown[] = [];
    let clientes: unknown[] = [];
    let categorias: unknown[] = [];

    try {
      produtos = await produtoRepository.getAll(scope);
    } catch (e: unknown) {
      console.error('Erro ao carregar produtos no dashboard:', e);
    }

    try {
      clientes = await clienteRepository.getAll(scope);
    } catch (e: unknown) {
      console.error('Erro ao carregar clientes no dashboard:', e);
    }

    try {
      pedidos = await pedidoRepository.getAllEnriched(scope);
      stats = await pedidoRepository.getDashboardStats(scope);
    } catch (e: unknown) {
      console.error('Erro ao carregar pedidos no dashboard:', e);
    }

    try {
      const { data: catData } = await supabaseServer
        .from('categorias')
        .select('*')
        .eq('organizacao_id', scope.organizationId);
      if (catData) categorias = catData;
    } catch (e: unknown) {
      console.error('Erro ao carregar categorias no dashboard:', e);
    }

    return NextResponse.json({
      success: true,
      data: {
        categorias,
        pedidos,
        produtos,
        clientes,
        estatisticas: {
          faturamento30Dias: stats.faturamento30 || 0,
          totalPedidos: stats.total || 0,
          pendentes: stats.pendentes || 0,
          cancelados: stats.cancelados || 0,
          atendidos: stats.atendidos || 0,
        }
      }
    });
  } catch (error: unknown) {
    console.error('Erro ao ler dados do painel:', error);
    const errMsg = error instanceof Error ? error.message : 'Erro ao carregar dados do dashboard';
    return NextResponse.json(
      { success: false, error: errMsg },
      { status: 500 }
    );
  }
}
