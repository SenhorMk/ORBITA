import { NextResponse } from 'next/server';
import { clienteRepository } from '@/repositories/clienteRepository';
import { bling } from '@/services/bling';
import { escopoTemCapacidade, resolveVerifiedOrganizationScope } from '@/lib/requestOrganizationContext';
import { registrarFalhaInterna, MENSAGEM_PUBLICA_DE_FALHA } from '@/lib/observability/falhaInterna';

export async function POST(request: Request) {
  const logEntries: string[] = [];
  try {
    // A autorização vem do escopo verificado (identidade + vínculo persistido
    // nesta organização), nunca de metadados do provedor de identidade.
    const scopeResult = await resolveVerifiedOrganizationScope(request);
    if (scopeResult._tag !== 'RequestScopeResolved') return scopeResult.response;
    const scope = scopeResult.scope;
    if (!escopoTemCapacidade(scope, 'organization:manage')) {
      return NextResponse.json({ success: false, error: 'Acesso negado: apenas quem administra a organização pode realizar esta ação.' }, { status: 403 });
    }

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
        // `logs` volta ao cliente **numa resposta 200**, então esta linha não
        // pode carregar a mensagem do erro (CWE-209). O fato fica — o cliente
        // local foi excluído e o remoto não —; a causa vai para o log do servidor.
        registrarFalhaInterna('clientes.delete.bling', err, { organizacaoId: scope.organizationId });
        logEntries.push(`[${new Date().toISOString()}] ⚠️ Falha ao deletar o contato no Bling. Continuando para excluir no cache local.`);
      }
    }

    // Deletar no Supabase Cache
    try {
      logEntries.push(`[${new Date().toISOString()}] 💾 Removendo cliente do Supabase (ID: ${id})...`);
      await clienteRepository.delete(scope, id);
      logEntries.push(`[${new Date().toISOString()}] ✅ Cliente removido do Supabase com sucesso.`);
    } catch (err: unknown) {
      // Nem a mensagem do banco nem os `logs` acumulados vão ao cliente
      // (CWE-209): o diagnóstico fica no log do servidor, e a resposta diz só
      // que falhou.
      registrarFalhaInterna('clientes.delete.supabase', err, { organizacaoId: scope.organizationId });
      return NextResponse.json(
        { success: false, error: 'Falha ao deletar do banco de dados local.' },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true, logs: logEntries });
  } catch (err: unknown) {
    registrarFalhaInterna('clientes.delete', err);
    return NextResponse.json(
      { success: false, error: MENSAGEM_PUBLICA_DE_FALHA },
      { status: 500 }
    );
  }
}
