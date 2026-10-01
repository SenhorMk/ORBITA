import { NextResponse } from 'next/server';

import { resolveVerifiedOrganizationScope } from '@/lib/requestOrganizationContext';
import { supabaseServer } from '@/lib/supabaseServer';
import { produtoRepository } from '@/repositories/produtoRepository';
import { SupabaseArmazenamentoDeImagem } from '@/services/armazenamentoDeImagem';
import { comImagemEfetiva } from '@/services/imagemEfetivaDoProduto';

/**
 * Produtos da organização verificada.
 *
 * Mesma história de `clientes`: a rota não existia, `EditOrderModal` a chamava
 * e recebia 404. As rotas de escrita existiam; só a leitura ficou de fora.
 *
 * `imagem_url` sai como a imagem efetiva, com a mesma precedência de
 * `/api/dashboard`.
 */
export const dynamic = 'force-dynamic';

const armazenamentoDeImagem = new SupabaseArmazenamentoDeImagem(supabaseServer);

export async function GET(request: Request) {
  const scopeResult = await resolveVerifiedOrganizationScope(request);
  if (scopeResult._tag !== 'RequestScopeResolved') return scopeResult.response;

  const { scope } = scopeResult;
  const produtos = await comImagemEfetiva(scope, await produtoRepository.getAll(scope), armazenamentoDeImagem);
  return NextResponse.json(produtos);
}
