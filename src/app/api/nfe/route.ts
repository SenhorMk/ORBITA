import { NextResponse } from 'next/server';
import { bling } from '@/services/bling';
import { pedidoRepository } from '@/repositories/pedidoRepository';
import { verifySessionAndRole } from '@/lib/auth';
import { supabaseServer } from '@/lib/supabaseServer';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    // 0. Validação de Sessão e Role
    const session = await verifySessionAndRole(request);
    if (!session) {
      return NextResponse.json({ success: false, error: 'Não autorizado' }, { status: 401 });
    }
    if (session.role !== 'dono') {
      return NextResponse.json({ success: false, error: 'Acesso negado: Somente o dono da loja pode faturar pedidos.' }, { status: 403 });
    }

    const { pedidoId, blingPedidoId } = await request.json();

    if (!pedidoId || !blingPedidoId) {
      return NextResponse.json(
        { success: false, error: 'pedidoId e blingPedidoId são obrigatórios' },
        { status: 400 }
      );
    }

    // C8: Prevenir double-faturamento no Bling checando se o pedido já tem NF-e local
    if (!(process.env.MOCK_MODE === 'true' && process.env.NODE_ENV === 'development')) {
      // 1. Tentar obter lock exclusivo no pedido (Advisory Lock)
      const { data: lockAcquired, error: lockError } = await supabaseServer.rpc('try_nfe_lock', { p_pedido_id: pedidoId });
      
      if (lockError || !lockAcquired) {
        return NextResponse.json({ success: false, error: 'Outra emissão de nota já está em andamento para este pedido.' }, { status: 429 });
      }

      try {
        // 2. Verificar no banco se a NF-e já existe
        const { data: nfeExistente, error: nfeError } = await supabaseServer
          .from('nfes')
          .select('*')
          .eq('pedido_id', pedidoId)
          .eq('user_id', session.tenant.id)
          .maybeSingle();

        if (nfeError) {
          return NextResponse.json({ success: false, error: nfeError.message }, { status: 500 });
        }

        if (nfeExistente) {
          return NextResponse.json(
            { success: false, error: `Este pedido já possui a NF-e número ${nfeExistente.numero} emitida.` },
            { status: 400 }
          );
        }

        // 1. Emitir nota fiscal através do Bling Client
        console.log(`🧾 Emitindo nota fiscal no Bling para o pedido ${blingPedidoId}...`);
        const blingClient = bling.forUser(session.tenant);
        const nfeResult = await blingClient.createNfe(blingPedidoId);

        // Bling v3 envelopa a resposta em { data: {...} }; extrair com fallbacks defensivos.
        const nfeData: any = nfeResult?.data ?? nfeResult ?? {};
        const nfeBlingId = String(nfeData.id ?? nfeData.bling_id ?? '');
        const nfeNumero = nfeData.numero ?? nfeData.numeroNFE ?? '';
        const nfeChave = nfeData.chave ?? nfeData.chaveAcesso ?? null;
        const nfeStatus = nfeData.status ?? nfeData.situacao ?? 'Emitida';

        if (!nfeBlingId || !nfeNumero) {
          console.error('[nfe] Resposta do Bling sem identificador/numero esperados:', JSON.stringify(nfeResult));
          return NextResponse.json({
            success: false,
            error: 'NF-e emitida no Bling, mas resposta inválida. Reconciliação manual necessária.',
            raw: nfeResult,
          }, { status: 502 });
        }

        // M8: Fluxo fiscal com compensação e tratamento de erro estruturado.
        let nfeCache;
        try {
          // 2. Persistir nota fiscal gerada no cache local associando ao ID do pedido
          nfeCache = await pedidoRepository.upsertNfe(session!.tenant, {
            bling_id: nfeBlingId,
            numero: String(nfeNumero),
            chave: nfeChave,
            status: nfeStatus,
            pedido_id: pedidoId,
          });

          // 3. Atualizar status do pedido local para Atendido/Faturado
          const pedidoLocal = await pedidoRepository.getById(session!.tenant, pedidoId);
          if (pedidoLocal) {
            await pedidoRepository.upsert(session!.tenant, {
              ...pedidoLocal,
              status: 'Atendido'
            });
          }
        } catch (dbError: any) {
          console.error('❌ CRÍTICO: NF-e emitida com sucesso no Bling, mas ocorreu uma falha ao atualizar o banco local!', dbError);
          return NextResponse.json({
            success: false,
            error: 'Nota fiscal foi gerada com sucesso no ERP Bling, porém ocorreu um erro ao salvar o registro no banco local. Pendente reconciliação manual.',
            compensation_required: true,
            bling_nfe_id: nfeBlingId,
            numero: String(nfeNumero),
            chave: nfeChave,
            db_error: dbError.message || dbError
          }, { status: 500 });
        }

        return NextResponse.json({
          success: true,
          data: nfeCache,
        });

      } catch (error: any) {
        console.error('Erro na emissão de NF-e:', error);
        return NextResponse.json(
          { success: false, error: error.message || 'Falha ao emitir nota fiscal no ERP' },
          { status: 500 }
        );
      } finally {
        await supabaseServer.rpc('unlock_nfe', { p_pedido_id: pedidoId });
      }
    } else {
        // Implementar lógica de mock se necessário
        return NextResponse.json({ success: true, data: { status: 'mock' } });
    }
  } catch (error: any) {
    console.error('Erro na emissão de NF-e:', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Falha ao processar solicitação' },
      { status: 500 }
    );
  }
}
