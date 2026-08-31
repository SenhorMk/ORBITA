import { NextResponse } from 'next/server';
import { bling } from '@/services/bling';
import type { BlingPort } from '@/services/blingPort';
import { pedidoRepository } from '@/repositories/pedidoRepository';
import { verifySessionAndRole } from '@/lib/auth';
import { supabaseServer } from '@/lib/supabaseServer';
import { resolveVerifiedOrganizationScope } from '@/lib/requestOrganizationContext';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import { descreverErro } from '@/lib/erroLegivel';

export const dynamic = 'force-dynamic';

interface NfeApiResponse {
  id?: number | string;
  bling_id?: number | string;
  numero?: string;
  numeroNFE?: string;
  chave?: string;
  chaveAcesso?: string;
  status?: string;
  situacao?: string;
  data?: NfeApiResponse;
}


/** Emite a NF-e no Bling e persiste o resultado local. Assume que o advisory lock do pedido já foi adquirido pelo chamador. */
async function emitNfeWithLock(
  scope: VerifiedOrganizationScope,
  pedidoId: string,
  blingPedidoId: string,
  blingClient: BlingPort,
): Promise<NextResponse> {
  // 2. Verificar no banco se a NF-e já existe na tabela canônica
  const { data: nfeExistente, error: nfeError } = await supabaseServer
    .from('documentos_fiscais')
    .select('*')
    .eq('pedido_id', pedidoId)
    .eq('organizacao_id', scope.organizationId)
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
  const nfeResult = (await blingClient.createNfe(blingPedidoId)) as NfeApiResponse;

  // Bling v3 envelopa a resposta em { data: {...} }; extrair com fallbacks defensivos.
  const nfeData = (nfeResult?.data ?? nfeResult ?? {}) as NfeApiResponse;
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
  try {
    // 2. Persistir nota fiscal gerada no cache local associando ao ID do pedido
    const nfeCache = await pedidoRepository.upsertNfe(scope, {
      bling_id: nfeBlingId,
      numero: String(nfeNumero),
      chave: nfeChave || '',
      status: nfeStatus,
      pedido_id: pedidoId,
    });

    // 3. Atualizar status do pedido local para Atendido/Faturado
    const pedidoLocal = await pedidoRepository.getById(scope, pedidoId);
    if (pedidoLocal) {
      await pedidoRepository.upsert(scope, {
        ...pedidoLocal,
        status: 'Atendido'
      });
    }

    return NextResponse.json({ success: true, data: nfeCache });
  } catch (dbError: unknown) {
    const dbErrMsg = descreverErro(dbError);
    console.error('❌ CRÍTICO: NF-e emitida com sucesso no Bling, mas ocorreu uma falha ao atualizar o banco local!', dbError);
    return NextResponse.json({
      success: false,
      error: 'Nota fiscal foi gerada com sucesso no ERP Bling, porém ocorreu um erro ao salvar o registro no banco local. Pendente reconciliação manual.',
      compensation_required: true,
      bling_nfe_id: nfeBlingId,
      numero: String(nfeNumero),
      chave: nfeChave,
      db_error: dbErrMsg
    }, { status: 500 });
  }
}

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

    const scopeResult = await resolveVerifiedOrganizationScope(request);
    if (scopeResult._tag !== 'RequestScopeResolved') return scopeResult.response;
    const scope = scopeResult.scope;

    const { pedidoId, blingPedidoId } = await request.json();

    if (!pedidoId || !blingPedidoId) {
      return NextResponse.json(
        { success: false, error: 'pedidoId e blingPedidoId são obrigatórios' },
        { status: 400 }
      );
    }

    // C8: Prevenir double-faturamento no Bling checando se o pedido já tem NF-e local
    if (!(process.env.MOCK_MODE === 'true' && process.env.NODE_ENV === 'development')) {
      // 1. Tentar obter lock exclusivo no pedido (Advisory Lock), verificado
      // pela organizacao ativa (nunca pelo user_id primitivo).
      const { data: lockAcquired, error: lockError } = await supabaseServer.rpc('tentar_lock_nfe_organizacao', {
        p_organizacao_id: scope.organizationId,
        p_pedido_id: pedidoId,
      });

      if (lockError || !lockAcquired) {
        return NextResponse.json({ success: false, error: 'Outra emissão de nota já está em andamento para este pedido.' }, { status: 429 });
      }

      try {
        const blingClient = bling.forVerifiedOrganization(scope);
        return await emitNfeWithLock(scope, pedidoId, blingPedidoId, blingClient);
      } catch (error: unknown) {
        console.error('Erro na emissão de NF-e:', error);
        const errMsg = error instanceof Error ? error.message : 'Falha ao emitir nota fiscal no ERP';
        return NextResponse.json(
          { success: false, error: errMsg },
          { status: 500 }
        );
      } finally {
        await supabaseServer.rpc('liberar_lock_nfe_organizacao', {
          p_organizacao_id: scope.organizationId,
          p_pedido_id: pedidoId,
        });
      }
    } else {
        // Implementar lógica de mock se necessário
        return NextResponse.json({ success: true, data: { status: 'mock' } });
    }
  } catch (error: unknown) {
    console.error('Erro na emissão de NF-e:', error);
    const errMsg = error instanceof Error ? error.message : 'Falha ao processar solicitação';
    return NextResponse.json(
      { success: false, error: errMsg },
      { status: 500 }
    );
  }
}
