import { NextResponse } from 'next/server';
import { z } from 'zod';

import { resolveVerifiedOrganizationScope } from '@/lib/requestOrganizationContext';
import { registrarFalhaInterna, MENSAGEM_PUBLICA_DE_FALHA } from '@/lib/observability/falhaInterna';
import { listarMovimentacoesDoProduto } from '@/repositories/movimentacaoEstoqueRepository';

export const dynamic = 'force-dynamic';

const produtoSchema = z.string().uuid();

/** `GET /api/produtos/movimentacoes?produto=<uuid>`: as últimas movimentações de estoque do produto. */
export async function GET(request: Request) {
  const scopeResult = await resolveVerifiedOrganizationScope(request);
  if (scopeResult._tag !== 'RequestScopeResolved') return scopeResult.response;

  const produto = produtoSchema.safeParse(new URL(request.url).searchParams.get('produto'));
  if (!produto.success) {
    return NextResponse.json({ success: false, error: 'Produto inválido.' }, { status: 400 });
  }

  try {
    const movimentacoes = await listarMovimentacoesDoProduto(scopeResult.scope, produto.data);
    return NextResponse.json({ success: true, movimentacoes });
  } catch (err: unknown) {
    registrarFalhaInterna('produtos.movimentacoes', err, { organizacaoId: scopeResult.scope.organizationId });
    return NextResponse.json({ success: false, error: MENSAGEM_PUBLICA_DE_FALHA }, { status: 500 });
  }
}
