import { NextResponse } from 'next/server';

import { resolveVerifiedOrganizationScope } from '@/lib/requestOrganizationContext';
import { produtoRepository } from '@/repositories/produtoRepository';

/**
 * Produtos da organização verificada.
 *
 * Mesma história de `clientes`: a rota não existia, `EditOrderModal` a chamava
 * e recebia 404. As rotas de escrita existiam; só a leitura ficou de fora.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const scopeResult = await resolveVerifiedOrganizationScope(request);
  if (scopeResult._tag !== 'RequestScopeResolved') return scopeResult.response;

  const produtos = await produtoRepository.getAll(scopeResult.scope);
  return NextResponse.json(produtos);
}
