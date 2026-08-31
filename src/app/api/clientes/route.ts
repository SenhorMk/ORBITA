import { NextResponse } from 'next/server';

import { resolveVerifiedOrganizationScope } from '@/lib/requestOrganizationContext';
import { clienteRepository } from '@/repositories/clienteRepository';

/**
 * Contatos da organização verificada.
 *
 * A rota não existia. `EditOrderModal` a chamava desde sempre e recebia 404,
 * então a lista de clientes do formulário de edição de pedido nunca carregou.
 * As rotas irmãs `clientes/update` e `clientes/delete` existiam; só a leitura
 * ficou de fora.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const scopeResult = await resolveVerifiedOrganizationScope(request);
  if (scopeResult._tag !== 'RequestScopeResolved') return scopeResult.response;

  const clientes = await clienteRepository.getAll(scopeResult.scope);
  return NextResponse.json(clientes);
}
