import { NextResponse } from 'next/server';

import { organizationContextStatus } from '@/lib/organizationAuthorization';
import { resolveActiveRequestOrganizationContext } from '@/lib/requestOrganizationContext';
import { organizationContextToScope, type VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import { produtoRepository } from '@/repositories/produtoRepository';
import { supabaseServer } from '@/lib/supabaseServer';
import { bling } from '@/services/bling';
import type { BlingPort } from '@/services/blingPort';
import { descreverErro } from '@/lib/erroLegivel';
import { getCorrelationId } from '@/lib/observability/correlation';
import { recordAuditEvent } from '@/services/auditService';

import {
  createProdutoUpdateHandler,
  type ProdutoAuthPort,
  type ProdutoBlingPort,
  type ProdutoCategoriaPort,
  type ProdutoStorePort,
  type EventoDoProduto,
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
            message: descreverErro(error),
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

/**
 * O UUID local vira o id do Bling aqui, e em nenhum lugar antes.
 *
 * O filtro por `organizacao_id` é explícito porque `supabaseServer` usa a
 * service-role e passa por cima da RLS: sem ele, um UUID de categoria de outra
 * organização seria resolvido normalmente e o produto acabaria apontado para a
 * categoria de outra conta do ERP. `maybeSingle` é o que distingue "não existe"
 * de erro, e `bling_id` é texto no banco — só um inteiro positivo serve, porque
 * `ProdutosCategoriaDTO.id` é integer.
 */
const categorias: ProdutoCategoriaPort = {
  async resolverBlingId(scope, categoriaId) {
    const { data, error } = await supabaseServer
      .from('categorias')
      .select('bling_id')
      .eq('id', categoriaId)
      .eq('organizacao_id', scope.organizationId)
      .maybeSingle();

    if (error) throw error;
    const bruto = data?.bling_id;
    if (typeof bruto !== 'string' || !/^\d+$/u.test(bruto.trim())) return null;

    const id = Number(bruto.trim());
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  },
};

const store: ProdutoStorePort = {
  async upsert(scope, produto) {
    const salvo = await produtoRepository.upsert(scope, {
      id: produto.id,
      bling_id: produto.blingId,
      nome: produto.nome,
      codigo: produto.codigo ?? '',
      preco: produto.preco,
      ...(produto.estoque !== undefined ? { estoque: produto.estoque } : {}),
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

/** Pela infraestrutura existente: catálogo validado e RPC que reconfere a membership do ator. */
async function auditar(scope: VerifiedOrganizationScope, evento: EventoDoProduto): Promise<void> {
  await recordAuditEvent(supabaseServer, scope, {
    acao: evento.acao,
    recurso: 'produto',
    recursoId: evento.recursoId,
    correlationId: evento.correlationId,
    metadata: { ...evento.metadata },
  });
}

export async function POST(request: Request): Promise<NextResponse> {
  const authorization = await auth.authorize(request);
  if (authorization._tag === 'Denied') return authorization.response;

  const handler = createProdutoUpdateHandler({
    auth: { async authorize() { return authorization; } },
    bling: blingProdutoAdapter(bling.forVerifiedOrganization(authorization.scope)),
    store,
    categorias,
    auditar,
    correlationId: getCorrelationId,
  });

  return handler(request);
}
