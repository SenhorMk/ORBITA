import { NextResponse } from 'next/server';

import { autorizarCorrecaoOperacional } from '@/lib/correcaoOperacionalServidor';
import { MENSAGEM_PUBLICA_DE_FALHA, registrarFalhaInterna } from '@/lib/observability/falhaInterna';
import { supabaseServer } from '@/lib/supabaseServer';
import { ProdutoImagemRepository } from '@/repositories/produtoImagemRepository';
import { produtoRepository } from '@/repositories/produtoRepository';
import { SupabaseArmazenamentoDeImagem } from '@/services/armazenamentoDeImagem';
import { bling } from '@/services/bling';
import { excluirProdutoComFoto } from '@/services/exclusaoDeProdutoComFoto';

import { createExclusaoDeProdutoHandler } from './handler';

const armazenamentoDeImagem = new SupabaseArmazenamentoDeImagem(supabaseServer);
const produtos = new ProdutoImagemRepository(supabaseServer);

const excluirProduto = createExclusaoDeProdutoHandler({
  autorizar: autorizarCorrecaoOperacional,
  carregar: async (scope, id) => {
    const produto = await produtos.carregar(scope, id);
    return produto ? { id: produto.id, blingId: produto.blingId } : null;
  },
  bling: (scope) => bling.forVerifiedOrganization(scope),
  // A foto do ORBITA sai do Storage só depois da linha, pelo caminho que o
  // banco devolveu na exclusão. Falha nessa limpeza não é falha da exclusão.
  excluirLocal: async (scope, id) => {
    await excluirProdutoComFoto(scope, id, {
      excluirLinha: (escopo, produtoId) => produtoRepository.delete(escopo, produtoId),
      armazenamento: armazenamentoDeImagem,
    });
  },
});

export async function POST(request: Request) {
  try {
    return await excluirProduto(request);
  } catch (err: unknown) {
    // Falha antes de qualquer efeito remoto (a carga do produto, por exemplo).
    registrarFalhaInterna('produtos.delete', err);
    return NextResponse.json({ success: false, error: MENSAGEM_PUBLICA_DE_FALHA }, { status: 500 });
  }
}
