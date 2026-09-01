import { NextResponse } from 'next/server';
import { clienteRepository } from '@/repositories/clienteRepository';
import { bling } from '@/services/bling';
import { escopoTemCapacidade, resolveVerifiedOrganizationScope } from '@/lib/requestOrganizationContext';
import { registrarFalhaInterna, MENSAGEM_PUBLICA_DE_FALHA } from '@/lib/observability/falhaInterna';
import { descreverErro } from '@/lib/erroLegivel';

export async function POST(request: Request) {
  const logEntries: string[] = [];
  try {
    // Ticket 22 — o portão de sessão legado saiu, e o `session.role !== 'dono'`
    // com ele: aquele papel vinha de `app_metadata`, do modelo de tenancy por
    // usuário, e não dizia nada sobre o papel da pessoa *nesta organização*. A
    // pergunta certa é a capacidade, e a fonte é o vínculo persistido.
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
        const errMsg = descreverErro(err);
        logEntries.push(`[${new Date().toISOString()}] ⚠️ Erro ao deletar no Bling: ${errMsg}. Continuando para excluir no cache local.`);
      }
    }

    // Deletar no Supabase Cache
    try {
      logEntries.push(`[${new Date().toISOString()}] 💾 Removendo cliente do Supabase (ID: ${id})...`);
      await clienteRepository.delete(scope, id);
      logEntries.push(`[${new Date().toISOString()}] ✅ Cliente removido do Supabase com sucesso.`);
    } catch (err: unknown) {
      // Ticket 22, critério 13 — `details` levava a mensagem do banco ao
      // cliente, e `logs` levava junto tudo o que este handler escreveu no
      // caminho. Os dois eram inertes atrás do 401 legado. O diagnóstico fica
      // no log do servidor; a resposta diz só que falhou.
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
