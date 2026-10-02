import { NextResponse } from 'next/server';
import { z } from 'zod';

import { registrarFalhaInterna } from '@/lib/observability/falhaInterna';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import type { DesfechoDaExclusaoRemota } from '@/services/exclusaoRemotaConfirmada';
import { excluirProdutoNoBling, type ProdutoNoBlingParaExclusao } from '@/services/exclusaoDeProdutoNoBling';

/**
 * `POST /api/produtos/delete` — exclusão de produto, **Bling primeiro e
 * confirmado**.
 *
 * 1. escopo verificado e `organization:manage`;
 * 2. o produto é carregado por `id` + organização. O corpo só traz o `id`: um
 *    `bling_id` mandado pelo navegador é descartado — o vínculo vem do banco;
 * 3. com vínculo no Bling: situação `E`, `DELETE` e leitura confirmando `404`
 *    (`excluirProdutoNoBling`). Sem essa prova, **nada local é apagado**;
 * 4. só então a linha local sai, e depois dela a foto no Storage
 *    (`excluirLocal`, que é `excluirProdutoComFoto`).
 *
 * A versão anterior apagava o local mesmo com o Bling falhando — e o `DELETE`
 * direto de produto ativo SEMPRE falha (400, código 12): o produto sumia do
 * ORBITA e ficava vivo no Bling, para a próxima sincronização trazê-lo de volta.
 *
 * Repetir é seguro: com o produto já fora do Bling, a mudança de situação
 * responde 404, a leitura confirma a ausência e a exclusão local conclui.
 */

export interface ProdutoParaExclusao {
  readonly id: string;
  /** O `bling_id` **gravado**, e só quando numérico. `null` = produto só do ORBITA. */
  readonly blingId: string | null;
}

export interface ExclusaoDeProdutoDependencies {
  readonly autorizar: (request: Request) => Promise<
    | { readonly _tag: 'Autorizado'; readonly scope: VerifiedOrganizationScope }
    | { readonly _tag: 'Negado'; readonly response: NextResponse }
  >;
  readonly carregar: (scope: VerifiedOrganizationScope, id: string) => Promise<ProdutoParaExclusao | null>;
  readonly bling: (scope: VerifiedOrganizationScope) => ProdutoNoBlingParaExclusao;
  /** Exclui a linha local e, depois dela, a foto. Lança quando a linha não sai. */
  readonly excluirLocal: (scope: VerifiedOrganizationScope, id: string) => Promise<void>;
}

/** Só o `id`. `z.object` descarta qualquer outra chave do corpo. */
const corpoSchema = z.object({ id: z.string().uuid() });

function falha(error: string, status: number): NextResponse {
  return NextResponse.json({ success: false, error }, { status });
}

/** Frase pública de cada desfecho sem prova de ausência. Nada do corpo do Bling. */
function respostaSemExclusaoRemota(desfecho: Exclude<DesfechoDaExclusaoRemota, { _tag: 'AusenciaConfirmada' }>): NextResponse {
  const mantido = 'O produto foi mantido no ORBITA.';
  switch (desfecho._tag) {
    case 'Recusada':
      return falha(`O Bling recusou a exclusão do produto (HTTP ${desfecho.status}). ${mantido}`, 409);
    case 'Limitada':
      return falha(`O Bling está limitando as requisições no momento. ${mantido} Tente de novo em instantes.`, 503);
    case 'RemotoAindaExiste':
      return falha(`O Bling não confirmou a exclusão: o produto continua lá. ${mantido}`, 409);
    case 'Indeterminada':
      return falha(`Não foi possível confirmar a exclusão no Bling. ${mantido} Tente de novo.`, 503);
  }
}

export function createExclusaoDeProdutoHandler(deps: ExclusaoDeProdutoDependencies) {
  return async function excluirProduto(request: Request): Promise<NextResponse> {
    const autorizacao = await deps.autorizar(request);
    if (autorizacao._tag === 'Negado') return autorizacao.response;
    const { scope } = autorizacao;

    let bruto: unknown;
    try {
      bruto = await request.json();
    } catch {
      return falha('O ID do produto local é obrigatório.', 400);
    }
    const lido = corpoSchema.safeParse(bruto);
    if (!lido.success) return falha('O ID do produto local é obrigatório.', 400);

    const produto = await deps.carregar(scope, lido.data.id);
    if (!produto) return falha('Produto não encontrado.', 404);

    if (produto.blingId !== null) {
      const desfecho = await excluirProdutoNoBling(deps.bling(scope), produto.blingId);
      if (desfecho._tag !== 'AusenciaConfirmada') return respostaSemExclusaoRemota(desfecho);
    }

    try {
      await deps.excluirLocal(scope, produto.id);
    } catch (erro: unknown) {
      registrarFalhaInterna('produtos.delete.local', erro, { organizacaoId: scope.organizationId });
      return falha(
        produto.blingId === null
          ? 'Falha ao excluir o produto no ORBITA.'
          : 'O produto foi excluído no Bling, mas a exclusão no ORBITA falhou. Tente de novo para concluir.',
        500,
      );
    }

    return NextResponse.json({ success: true, message: 'Produto excluído.', removidoDoBling: produto.blingId !== null });
  };
}
