import { NextResponse } from 'next/server';

import { organizationContextStatus } from '@/lib/organizationAuthorization';
import { resolveActiveRequestOrganizationContext } from '@/lib/requestOrganizationContext';
import { organizationContextToScope } from '@/lib/verifiedOrganizationScope';
import { produtoRepository } from '@/repositories/produtoRepository';
import { bling } from '@/services/bling';
import type { BlingPort } from '@/services/blingPort';

import {
  createProdutoUpdateHandler,
  type ProdutoAuthPort,
  type ProdutoBlingPort,
  type ProdutoStorePort,
} from './handler';

export type {
  ProdutoBlingPort,
  ProdutoDependencies,
  ProdutoStorePort,
} from './handler';

/**
 * Autorização por **capacidade organizacional**, não pelo papel legado do
 * tenant.
 *
 * A versão anterior recusava com `session.role !== 'dono'`, papel derivado da
 * sessão e não da associação à organização — o mesmo tipo de autoridade que os
 * tickets 26 e 28 tiveram de corrigir. `organization:manage` é o que
 * `POST /api/bling/connect` e `POST /api/chatwoot/connect` já exigem.
 */
const auth: ProdutoAuthPort = {
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
          { success: false, error: 'Capacidade insuficiente para gerenciar o catálogo' },
          { status: 403 },
        ),
      };
    }

    return { _tag: 'Authorized' as const, scope: organizationContextToScope(contextResult.context) };
  },
};

function blingProdutoAdapter(client: BlingPort): ProdutoBlingPort {
  return {
    async buscarPorCodigo(codigo) {
      try {
        const encontrado = await client.buscarProdutoPorCodigo(codigo);
        return {
          _tag: 'BlingOk',
          value: encontrado
            ? { id: String(encontrado.id), codigo: encontrado.codigo ? String(encontrado.codigo) : null }
            : null,
        };
      } catch (error: unknown) {
        return {
          _tag: 'BlingFailed',
          failure: {
            _tag: 'BlingProviderFailure',
            type: 'UNKNOWN_ERROR',
            status: 0,
            message: error instanceof Error ? error.message : String(error),
            duplicateSale: false,
          },
        };
      }
    },
    criar: (payload) => client.criarProduto(payload),
    atualizar: (id, payload) => client.atualizarProduto(id, payload),
    definirSaldo: (id, quantidade) => client.definirSaldoProduto(id, quantidade),
  };
}

const store: ProdutoStorePort = {
  async upsert(scope, produto) {
    const salvo = await produtoRepository.upsert(scope, {
      id: produto.id,
      bling_id: produto.blingId,
      nome: produto.nome,
      codigo: produto.codigo ?? '',
      preco: produto.preco,
      estoque: produto.estoque,
      categoria_id: produto.categoriaId,
    });

    return {
      id: salvo.id!,
      blingId: salvo.bling_id!,
      nome: salvo.nome,
      codigo: salvo.codigo ?? null,
      preco: Number(salvo.preco) || 0,
      estoque: Number(salvo.estoque) || 0,
    };
  },
};

export async function POST(request: Request): Promise<NextResponse> {
  const authorization = await auth.authorize(request);
  if (authorization._tag === 'Denied') return authorization.response;

  const handler = createProdutoUpdateHandler({
    auth: { async authorize() { return authorization; } },
    bling: blingProdutoAdapter(bling.forVerifiedOrganization(authorization.scope)),
    store,
  });

  return handler(request);
}
