import { NextResponse } from 'next/server';
import { pedidoRepository } from '@/repositories/pedidoRepository';
import { produtoRepository } from '@/repositories/produtoRepository';
import { clienteRepository } from '@/repositories/clienteRepository';
import { supabaseServer } from '@/lib/supabaseServer';
import { resolveVerifiedOrganizationScope } from '@/lib/requestOrganizationContext';
import { SupabaseArmazenamentoDeImagem } from '@/services/armazenamentoDeImagem';
import { comImagemEfetiva } from '@/services/imagemEfetivaDoProduto';

export const dynamic = 'force-dynamic';

const armazenamentoDeImagem = new SupabaseArmazenamentoDeImagem(supabaseServer);

export async function GET(request: Request) {
  try {
    const scopeResult = await resolveVerifiedOrganizationScope(request);
    if (scopeResult._tag !== 'RequestScopeResolved') return scopeResult.response;
    const scope = scopeResult.scope;

    // Nenhuma destas leituras é embrulhada em try/catch que devolve vazio.
    //
    // A versão anterior capturava cada uma e seguia com `[]` e estatísticas
    // zeradas, respondendo HTTP 200. Quando a consulta de pedidos quebrou por
    // um embed ambíguo, o painel passou a exibir "R$ 0,00" e "0 pedidos" com
    // três pedidos gravados no banco — e ninguém tinha como saber, porque a
    // resposta dizia sucesso.
    //
    // Zero e "não sei" são coisas diferentes. Num painel que mostra dinheiro,
    // confundir as duas é o pior erro possível: falhar em voz alta é a única
    // opção honesta.
    // É esta leitura que abastece Estoque: a foto do ORBITA, quando existe,
    // vira aqui a `imagem_url` apresentada — por URL assinada, gerada agora.
    const produtos = await comImagemEfetiva(scope, await produtoRepository.getAll(scope), armazenamentoDeImagem);
    const clientes = await clienteRepository.getAll(scope);
    const pedidos = await pedidoRepository.getAllEnriched(scope);
    const stats = await pedidoRepository.getDashboardStats(scope);

    const { data: catData, error: catErr } = await supabaseServer
      .from('categorias')
      .select('*')
      .eq('organizacao_id', scope.organizationId);
    if (catErr) throw catErr;
    const categorias = catData ?? [];

    return NextResponse.json({
      success: true,
      data: {
        categorias,
        pedidos,
        produtos,
        clientes,
        estatisticas: {
          faturamento30Dias: stats.faturamento30 || 0,
          // A janela anterior, para o painel comparar com um número real em
          // vez do valor fixo que vivia no componente.
          faturamento30DiasAnterior: stats.faturamento30Anterior || 0,
          totalPedidos: stats.total || 0,
          pendentes: stats.pendentes || 0,
          cancelados: stats.cancelados || 0,
          atendidos: stats.atendidos || 0,
        }
      }
    });
  } catch (error: unknown) {
    console.error('Erro ao ler dados do painel:', error);
    const errMsg = error instanceof Error ? error.message : 'Erro ao carregar dados do dashboard';
    return NextResponse.json(
      { success: false, error: errMsg },
      { status: 500 }
    );
  }
}
