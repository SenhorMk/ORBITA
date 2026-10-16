import { NextResponse } from 'next/server';

import { organizationContextStatus } from '@/lib/organizationAuthorization';
import { resolveActiveRequestOrganizationContext } from '@/lib/requestOrganizationContext';
import { organizationContextToScope } from '@/lib/verifiedOrganizationScope';
import { clienteRepository } from '@/repositories/clienteRepository';
import { bling } from '@/services/bling';
import type { BlingPort } from '@/services/blingPort';
import { supabaseServer } from '@/lib/supabaseServer';
import { getCorrelationId } from '@/lib/observability/correlation';
import { recordAuditEvent } from '@/services/auditService';
import { criarAuditoriaComercial } from '@/services/auditoriaComercial';

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
 * O papel vem da associação persistida à organização ativa, nunca da sessão
 * sozinha — a mesma regra usada no catálogo de produtos.
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

function blingClienteAdapter(client: BlingPort): ClienteBlingPort {
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
      tipo: cliente.tipo,
      indicador_ie: cliente.indicadorIe,
      cep: cliente.cep,
      endereco: cliente.endereco,
      numero: cliente.numero,
      bairro: cliente.bairro,
      cidade: cliente.cidade,
      uf: cliente.uf,
    });

    return { id: salvo.id!, blingId: salvo.bling_id!, nome: salvo.nome };
  },
  exclusaoVigenteNoBling: (scope, blingId) => clienteRepository.exclusaoVigenteNoBling(scope, blingId),
};

export async function POST(request: Request): Promise<NextResponse> {
  const authorization = await auth.authorize(request);
  if (authorization._tag === 'Denied') return authorization.response;

  const handler = createClienteUpdateHandler({
    auth: { async authorize() { return authorization; } },
    bling: blingClienteAdapter(bling.forVerifiedOrganization(authorization.scope)),
    store,
    auditar: criarAuditoriaComercial((scope, input) => recordAuditEvent(supabaseServer, scope, input)),
    correlationId: getCorrelationId,
  });

  return handler(request);
}
