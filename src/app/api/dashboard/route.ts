import { NextResponse } from 'next/server';
import { pedidoRepository } from '@/repositories/pedidoRepository';
import { produtoRepository } from '@/repositories/produtoRepository';
import { clienteRepository } from '@/repositories/clienteRepository';
import { verifySessionAndRole } from '@/lib/auth';
import { supabaseServer } from '@/lib/supabaseServer';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const session = await verifySessionAndRole(request);
    if (!session) {
      return NextResponse.json({ success: false, error: 'Não autorizado' }, { status: 401 });
    }

    let stats = { faturamento30: 0, total: 0, pendentes: 0, cancelados: 0, atendidos: 0 };
    let pedidos: any[] = [];
    let produtos: any[] = [];
    let clientes: any[] = [];
    let categorias: any[] = [];

    try {
      produtos = await produtoRepository.getAll(session.user.id);
    } catch (e: any) {
      console.error('Erro ao carregar produtos no dashboard:', e);
    }

    try {
      clientes = await clienteRepository.getAll(session.user.id);
    } catch (e: any) {
      console.error('Erro ao carregar clientes no dashboard:', e);
    }

    try {
      pedidos = await pedidoRepository.getAllEnriched(session.user.id);
      stats = await pedidoRepository.getDashboardStats(session.user.id);
    } catch (e: any) {
      console.error('Erro ao carregar pedidos no dashboard:', e);
    }

    try {
      const { data: catData } = await supabaseServer
        .from('categorias')
        .select('*')
        .eq('user_id', session.user.id);
      if (catData) categorias = catData;
    } catch (e: any) {
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
  } catch (error: any) {
    console.error('Erro ao ler dados do painel:', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Erro ao carregar dados do dashboard' },
      { status: 500 }
    );
  }
}

