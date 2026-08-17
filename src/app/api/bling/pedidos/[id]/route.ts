import { NextResponse } from 'next/server';
import { verifySessionAndRole } from '@/lib/auth';
import { bling } from '@/services/bling';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await verifySessionAndRole(request);
    if (!session) {
      return NextResponse.json({ success: false, error: 'Não autorizado' }, { status: 401 });
    }

    const { id } = await params;
    if (!id) {
      return NextResponse.json({ success: false, error: 'ID do pedido obrigatório' }, { status: 400 });
    }

    const blingClient = bling.forUser(session.tenant);
    const pedido = await blingClient.getPedido(id);

    if (!pedido) {
      return NextResponse.json({ success: false, error: 'Pedido não encontrado no Bling' }, { status: 404 });
    }

    return NextResponse.json({ success: true, data: pedido });
  } catch (error: any) {
    console.error(`Erro ao buscar pedido no Bling:`, error);
    return NextResponse.json(
      { success: false, error: error.message || 'Erro interno ao buscar pedido' },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await verifySessionAndRole(request);
    if (!session) {
      return NextResponse.json({ success: false, error: 'Não autorizado' }, { status: 401 });
    }

    let { id } = await params;
    if (!id) {
      return NextResponse.json({ success: false, error: 'ID do pedido obrigatório' }, { status: 400 });
    }

    id = decodeURIComponent(id);

    const blingClient = bling.forUser(session.tenant);
    
    // 1. Tenta apagar no Bling primeiro (fonte da verdade)
    // Se for manual (#MANUAL-...), não precisa apagar no Bling.
    if (!id.startsWith('#MANUAL-')) {
      try {
        await blingClient.deletePedido(id);
      } catch (err: any) {
        // Se já não existe no Bling (404), ignoramos o erro para poder limpar o cache local (pedido órfão)
        if (!err.message.includes('404')) {
          throw err;
        }
      }
    }

    // 2. Apaga do banco local (cache)
    const { supabaseServer } = await import('@/lib/supabaseServer');
    const { error: dbError } = await supabaseServer
      .from('pedidos')
      .delete()
      .eq('bling_id', id);

    if (dbError) {
      throw new Error(`Bling OK, mas erro ao apagar cache local: ${dbError.message}`);
    }

    return NextResponse.json({ success: true, message: 'Pedido apagado com sucesso' });
  } catch (error: any) {
    console.error(`Erro ao apagar pedido:`, error);
    return NextResponse.json(
      { success: false, error: error.message || 'Erro interno ao apagar pedido' },
      { status: 500 }
    );
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await verifySessionAndRole(request);
    if (!session) {
      return NextResponse.json({ success: false, error: 'Não autorizado' }, { status: 401 });
    }

    const { id } = await params;
    const body = await request.json();

    if (!id) {
      return NextResponse.json({ error: 'ID do pedido não fornecido' }, { status: 400 });
    }

    const blingClient = bling.forUser(session.tenant);

    // Tenta atualizar no Bling
    let updatedPedidoData = null;
    if (!id.startsWith('#MANUAL-')) {
      updatedPedidoData = await blingClient.updatePedido(id, body);
    }

    return NextResponse.json({ success: true, data: updatedPedidoData });
  } catch (error: any) {
    console.error(`Erro ao atualizar pedido no Bling:`, error);
    return NextResponse.json(
      { success: false, error: error.message || 'Erro interno ao atualizar pedido' },
      { status: 500 }
    );
  }
}
