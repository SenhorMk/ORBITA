import { NextResponse } from 'next/server';
import { clienteRepository } from '@/repositories/clienteRepository';
import { bling } from '@/services/bling';
import { verifySessionAndRole } from '@/lib/auth';
import { resolveVerifiedOrganizationScope } from '@/lib/requestOrganizationContext';

export async function POST(request: Request) {
  const logEntries: string[] = [];
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

    const body = await request.json();
    const { id, bling_id } = body;

    if (!id || !bling_id) {
      return NextResponse.json(
        { success: false, error: 'ID do cliente ou ID do Bling ausente.' },
        { status: 400 }
      );
    }

    logEntries.push(`[${new Date().toISOString()}] 🗑️ Iniciando exclusão do cliente (ID Supabase: ${id}, Bling ID: ${bling_id})`);

    // Deletar no Bling v3
    if (/^\d+$/.test(bling_id)) {
      const blingClient = bling.forVerifiedOrganization(scope);
      try {
        logEntries.push(`[${new Date().toISOString()}] 🌐 Chamando DELETE na API do Bling para o contato ${bling_id}...`);
        await blingClient.deleteContato(bling_id);
        logEntries.push(`[${new Date().toISOString()}] ✅ Contato deletado no Bling com sucesso.`);
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logEntries.push(`[${new Date().toISOString()}] ⚠️ Erro ao deletar no Bling: ${errMsg}. Continuando para excluir no cache local.`);
      }
    }

    // Deletar no Supabase Cache
    try {
      logEntries.push(`[${new Date().toISOString()}] 💾 Removendo cliente do Supabase (ID: ${id})...`);
      await clienteRepository.delete(scope, id);
      logEntries.push(`[${new Date().toISOString()}] ✅ Cliente removido do Supabase com sucesso.`);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logEntries.push(`[${new Date().toISOString()}] ❌ Erro ao deletar no Supabase: ${errMsg}`);
      return NextResponse.json(
        { success: false, error: 'Falha ao deletar do banco de dados local.', details: errMsg, logs: logEntries },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true, logs: logEntries });
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logEntries.push(`[${new Date().toISOString()}] 💥 Erro crítico ao processar exclusão: ${errMsg}`);
    return NextResponse.json(
      { success: false, error: 'Erro interno.', details: errMsg, logs: logEntries },
      { status: 500 }
    );
  }
}
