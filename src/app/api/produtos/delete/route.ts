import { NextResponse } from 'next/server';
import { produtoRepository } from '@/repositories/produtoRepository';
import { bling } from '@/services/bling';
import type { BlingPort } from '@/services/blingPort';
import { escopoTemCapacidade, resolveVerifiedOrganizationScope } from '@/lib/requestOrganizationContext';
import { registrarFalhaInterna, MENSAGEM_PUBLICA_DE_FALHA } from '@/lib/observability/falhaInterna';
import { supabaseServer } from '@/lib/supabaseServer';
import { SupabaseArmazenamentoDeImagem } from '@/services/armazenamentoDeImagem';
import { excluirProdutoComFoto } from '@/services/exclusaoDeProdutoComFoto';

const armazenamentoDeImagem = new SupabaseArmazenamentoDeImagem(supabaseServer);

/**
 * Exclusão remota best-effort: a exclusão local segue mesmo se o Bling falhar.
 *
 * Devolve **se falhou**, e não *por que* falhou: o motivo ia parar em `logs`,
 * que volta ao cliente numa resposta 200.
 */
async function attemptBlingProductDelete(
  blingClient: BlingPort,
  blingId: string | undefined,
  logEntries: string[],
): Promise<boolean> {
  if (!blingId || !/^\d+$/.test(blingId)) {
    logEntries.push(`[${new Date().toISOString()}] ℹ️ O produto não possuía um ID numérico no Bling, exclusão remota ignorada.`);
    return false;
  }
  logEntries.push(`[${new Date().toISOString()}] 🔄 Deletando produto no Bling ERP v3...`);
  try {
    await blingClient.deleteProduto(blingId);
    logEntries.push(`[${new Date().toISOString()}] ✅ Produto deletado no Bling ERP com sucesso!`);
    return false;
  } catch (deleteErr: unknown) {
    // Mesmo vazamento do `clientes/delete`, e no mesmo formato: `logs` volta ao
    // cliente numa resposta 200, e esta linha levava a causa dentro. O que sai
    // é que falhou; o porquê fica no log.
    registrarFalhaInterna('produtos.delete.bling', deleteErr);
    logEntries.push(`[${new Date().toISOString()}] ⚠️ Falha ao deletar no Bling (pode já ter sido excluído).`);
    return true;
  }
}

export async function POST(request: Request) {
  const logEntries: string[] = [];
  const timestamp = new Date().toISOString();

  try {
    // A autorização vem do escopo verificado (identidade + vínculo persistido
    // nesta organização), nunca de metadados do provedor de identidade.
    const scopeResult = await resolveVerifiedOrganizationScope(request);
    if (scopeResult._tag !== 'RequestScopeResolved') return scopeResult.response;
    const scope = scopeResult.scope;
    if (!escopoTemCapacidade(scope, 'organization:manage')) {
      return NextResponse.json({ success: false, error: 'Acesso negado: apenas quem administra a organização pode realizar esta ação.' }, { status: 403 });
    }
    const blingClient = bling.forVerifiedOrganization(scope);

    const body = await request.json();
    const { id, bling_id, nome } = body;

    if (!id) {
      return NextResponse.json({ success: false, error: 'O ID do produto local é obrigatório' }, { status: 400 });
    }

    logEntries.push(`[${timestamp}] 🗑️ Processando exclusão do produto: "${nome || id}" (ID Bling: ${bling_id || 'N/A'})`);

    // 1. Tentar deletar no Bling ERP v3 (se tiver um bling_id numérico válido)
    const falhouNoBling = await attemptBlingProductDelete(blingClient, bling_id, logEntries);

    // 2. Deletar do banco Supabase
    logEntries.push(`[${new Date().toISOString()}] 💾 Excluindo registro do banco Supabase...`);
    try {
      // A foto do ORBITA sai do Storage só depois da linha, pelo caminho que o
      // banco devolveu na exclusão. Falha nessa limpeza não é falha da exclusão.
      await excluirProdutoComFoto(scope, id, {
        excluirLinha: (escopo, produtoId) => produtoRepository.delete(escopo, produtoId),
        armazenamento: armazenamentoDeImagem,
      });
      logEntries.push(`[${new Date().toISOString()}] ✅ Registro excluído do Supabase!`);
    } catch (dbErr: unknown) {
      logEntries.push(`[${new Date().toISOString()}] ❌ Falha ao excluir o registro no Supabase.`);
      // O diagnóstico do banco não vai ao cliente (CWE-209): fica no log do
      // servidor, e a resposta diz só que falhou.
      registrarFalhaInterna('produtos.delete.supabase', dbErr, { organizacaoId: scope.organizationId });
      return NextResponse.json(
        { success: false, error: 'Falha ao deletar no banco de dados Supabase.' },
        { status: 500 }
      );
    }

    if (falhouNoBling) {
      // O aviso continua: o produto saiu daqui e não de lá, e quem chamou
      // precisa saber. O que sai é o fato, não o texto do erro.
      return NextResponse.json({
        success: true,
        warning: true,
        error: 'Produto excluído localmente, mas falhou ao tentar deletar na API do Bling ERP.',
      });
    }

    return NextResponse.json({
      success: true,
      message: 'Produto deletado com sucesso.',
      logs: logEntries,
    });
  } catch (err: unknown) {
    logEntries.push(`[${new Date().toISOString()}] 💥 Erro crítico ao processar a exclusão do produto.`);
    registrarFalhaInterna('produtos.delete', err);
    return NextResponse.json(
      { success: false, error: MENSAGEM_PUBLICA_DE_FALHA },
      { status: 500 }
    );
  }
}
