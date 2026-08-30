import { NextResponse } from 'next/server';
import { produtoRepository } from '@/repositories/produtoRepository';
import { bling } from '@/services/bling';
import { verifySessionAndRole } from '@/lib/auth';
import { resolveVerifiedOrganizationScope } from '@/lib/requestOrganizationContext';

/** Best-effort remote delete: local deletion must proceed even if the Bling side fails. */
async function attemptBlingProductDelete(
  blingClient: ReturnType<typeof bling.forVerifiedOrganization>,
  blingId: string | undefined,
  logEntries: string[],
): Promise<string | null> {
  if (!blingId || !/^\d+$/.test(blingId)) {
    logEntries.push(`[${new Date().toISOString()}] ℹ️ O produto não possuía um ID numérico no Bling, exclusão remota ignorada.`);
    return null;
  }
  logEntries.push(`[${new Date().toISOString()}] 🔄 Deletando produto no Bling ERP v3...`);
  try {
    await blingClient.deleteProduto(blingId);
    logEntries.push(`[${new Date().toISOString()}] ✅ Produto deletado no Bling ERP com sucesso!`);
    return null;
  } catch (deleteErr: unknown) {
    const blingError = deleteErr instanceof Error ? deleteErr.message : String(deleteErr);
    logEntries.push(`[${new Date().toISOString()}] ⚠️ Falha ao deletar no Bling (pode já ter sido excluído): ${blingError}`);
    return blingError;
  }
}

export async function POST(request: Request) {
  const logEntries: string[] = [];
  const timestamp = new Date().toISOString();

  try {
    const session = await verifySessionAndRole(request);
    if (!session) {
      return NextResponse.json({ success: false, error: 'Não autorizado' }, { status: 401 });
    }
    if (session.role !== 'dono') {
      return NextResponse.json({ success: false, error: 'Acesso negado: apenas o dono pode realizar esta ação.' }, { status: 403 });
    }
    const scopeResult = await resolveVerifiedOrganizationScope(request);
    if (scopeResult._tag !== 'RequestScopeResolved') return scopeResult.response;
    const scope = scopeResult.scope;
    const blingClient = bling.forVerifiedOrganization(scope);

    const body = await request.json();
    const { id, bling_id, nome } = body;

    if (!id) {
      return NextResponse.json({ success: false, error: 'O ID do produto local é obrigatório' }, { status: 400 });
    }

    logEntries.push(`[${timestamp}] 🗑️ Processando exclusão do produto: "${nome || id}" (ID Bling: ${bling_id || 'N/A'})`);

    // 1. Tentar deletar no Bling ERP v3 (se tiver um bling_id numérico válido)
    const blingError = await attemptBlingProductDelete(blingClient, bling_id, logEntries);

    // 2. Deletar do banco Supabase
    logEntries.push(`[${new Date().toISOString()}] 💾 Excluindo registro do banco Supabase...`);
    try {
      await produtoRepository.delete(scope, id);
      logEntries.push(`[${new Date().toISOString()}] ✅ Registro excluído do Supabase!`);
    } catch (dbErr: unknown) {
      const dbErrMsg = dbErr instanceof Error ? dbErr.message : String(dbErr);
      logEntries.push(`[${new Date().toISOString()}] ❌ ERRO SUPABASE: ${dbErrMsg}`);
      return NextResponse.json(
        {
          success: false,
          error: 'Falha ao deletar no banco de dados Supabase.',
          details: dbErrMsg,
          logs: logEntries,
        },
        { status: 500 }
      );
    }

    if (blingError) {
      return NextResponse.json({
        success: true,
        warning: true,
        error: 'Produto excluído localmente, mas falhou ao tentar deletar na API do Bling ERP.',
        details: blingError,
        logs: logEntries,
      });
    }

    return NextResponse.json({
      success: true,
      message: 'Produto deletado com sucesso.',
      logs: logEntries,
    });
  } catch (err: unknown) {
    const errMessage = err instanceof Error ? err.message : String(err);
    logEntries.push(`[${new Date().toISOString()}] 💥 ERRO CRÍTICO NA API DE EXCLUSÃO DE PRODUTOS: ${errMessage}`);
    return NextResponse.json(
      {
        success: false,
        error: 'Erro crítico interno ao processar a exclusão do produto.',
        details: errMessage,
        logs: logEntries,
      },
      { status: 500 }
    );
  }
}
