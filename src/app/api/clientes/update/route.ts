import { NextResponse } from 'next/server';

import { organizationContextStatus } from '@/lib/organizationAuthorization';
import { resolveActiveRequestOrganizationContext } from '@/lib/requestOrganizationContext';
import { organizationContextToScope } from '@/lib/verifiedOrganizationScope';
import { clienteRepository } from '@/repositories/clienteRepository';
import { bling } from '@/services/bling';

import {
  createClienteUpdateHandler,
  type ClienteAuthPort,
  type ClienteBlingPort,
  type ClienteStorePort,
} from './handler';

export type {
  ClienteBlingPort,
  ClienteDependencies,
  ClienteStorePort,
} from './handler';

/**
 * Autorização por capacidade organizacional.
 *
 * Substitui `session.role !== 'dono'`, papel derivado da sessão e não da
 * associação à organização — mesma correção feita no catálogo (Ticket 31).
 */
const auth: ClienteAuthPort = {
  async authorize(request: Request) {
    const contextResult = await resolveActiveRequestOrganizationContext(request);
    if (contextResult._tag !== 'OrganizationContextResolved') {
      const status = organizationContextStatus(contextResult);
      return {
        _tag: 'Denied' as const,
        response: NextResponse.json(
          { success: false, error: status === 503 ? 'Serviço de autorização indisponível' : 'Não autorizado' },
          { status },
        ),
      };
    }

    if (!contextResult.context.capabilities.has('organization:manage')) {
      return {
        _tag: 'Denied' as const,
        response: NextResponse.json(
          { success: false, error: 'Capacidade insuficiente para gerenciar clientes' },
          { status: 403 },
        ),
      };
    }

    return { _tag: 'Authorized' as const, scope: organizationContextToScope(contextResult.context) };
  },
};

function blingClienteAdapter(client: ReturnType<typeof bling.forVerifiedOrganization>): ClienteBlingPort {
  return {
    criar: (payload) => client.criarContato(payload),
    atualizar: (id, payload) => client.atualizarContato(id, payload),
  };
}

const store: ClienteStorePort = {
  async upsert(scope, cliente) {
    const salvo = await clienteRepository.upsert(scope, {
      id: cliente.id,
      bling_id: cliente.blingId,
      nome: cliente.nome,
      email: cliente.email,
      telefone: cliente.telefone,
      cpf_cnpj: cliente.cpfCnpj,
    });

    return { id: salvo.id!, blingId: salvo.bling_id!, nome: salvo.nome };
  },
};

export async function POST(request: Request): Promise<NextResponse> {
  const authorization = await auth.authorize(request);
  if (authorization._tag === 'Denied') return authorization.response;

  const handler = createClienteUpdateHandler({
    auth: { async authorize() { return authorization; } },
    bling: blingClienteAdapter(bling.forVerifiedOrganization(authorization.scope)),
    store,
  });

  return handler(request);
}
