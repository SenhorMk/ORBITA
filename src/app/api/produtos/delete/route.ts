import { NextResponse } from 'next/server';
import { produtoRepository } from '@/repositories/produtoRepository';
import { bling } from '@/services/bling';
import { verifySessionAndRole } from '@/lib/auth';

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
    const blingClient = bling.forUser(session.tenant);

    const body = await request.json();
    const { id, bling_id, nome } = body;

    if (!id) {
      return NextResponse.json({ success: false, error: 'O ID do produto local é obrigatório' }, { status: 400 });
    }

    logEntries.push(`[${timestamp}] 🗑️ Processando exclusão do produto: "${nome || id}" (ID Bling: ${bling_id || 'N/A'})`);

    let blingError: string | null = null;

    // 1. Tentar deletar no Bling ERP v3 (se tiver um bling_id numérico válido)
    if (bling_id && /^\d+$/.test(bling_id)) {
      logEntries.push(`[${new Date().toISOString()}] 🔄 Deletando produto no Bling ERP v3...`);
      try {
        await blingClient.deleteProduto(bling_id);
        logEntries.push(`[${new Date().toISOString()}] ✅ Produto deletado no Bling ERP com sucesso!`);
      } catch (deleteErr: unknown) {
        blingError = deleteErr instanceof Error ? deleteErr.message : String(deleteErr);
        logEntries.push(`[${new Date().toISOString()}] ⚠️ Falha ao deletar no Bling (pode já ter sido excluído): ${blingError}`);
      }
    } else {
      logEntries.push(`[${new Date().toISOString()}] ℹ️ O produto não possuía um ID numérico no Bling, exclusão remota ignorada.`);
    }

    // 2. Deletar do banco Supabase
    logEntries.push(`[${new Date().toISOString()}] 💾 Excluindo registro do banco Supabase...`);
    try {
      await produtoRepository.delete(session.tenant, id);
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
