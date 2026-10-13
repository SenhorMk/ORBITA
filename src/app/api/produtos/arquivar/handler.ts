import { NextResponse } from 'next/server';
import { z } from 'zod';

import type { SituacaoDoProduto, VinculoComBling } from '@/lib/config/produtoContract';
import { registrarFalhaInterna } from '@/lib/observability/falhaInterna';
import { logger } from '@/lib/observability/logger';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import {
  inativarProdutoNoBling,
  type DesfechoDaInativacaoRemota,
  type ProdutoNoBlingParaInativacao,
} from '@/services/inativacaoDeProdutoNoBling';

/**
 * `POST /api/produtos/arquivar` — retira o produto da venda **sem apagá-lo**
 * (PRE-003). Substitui a exclusão física, que com pedido falhava no banco
 * depois de o produto já ter saído do Bling, e sem pedido levava junto a
 * movimentação de estoque.
 *
 * 1. escopo verificado e `organization:manage`;
 * 2. o produto é carregado por `id` + organização; o corpo só traz o `id`;
 * 3. já arquivado: responde sucesso sem chamar o Bling (idempotente);
 * 4. com vínculo no Bling: situação `I` (inativo), com prova
 *    (`inativarProdutoNoBling`). Sem essa prova, **nada local muda**. Vínculo
 *    ambíguo (nem id do Bling nem `LOCAL-<timestamp>`) é recusado sem chamar o
 *    Bling: arquivar como local ignoraria uma possível conta remota;
 * 5. só então `arquivar_produto` (migration 75): trava a linha, marca
 *    `arquivado`, e não mexe em estoque, reserva, foto nem pedidos.
 *
 * Repetir é seguro: marcar inativo de novo no Bling não muda nada, e o
 * arquivamento local é idempotente.
 */

export interface ProdutoParaArquivamento {
  readonly id: string;
  /** O vínculo com o Bling, classificado a partir do `bling_id` **gravado**. */
  readonly vinculo: VinculoComBling;
  readonly situacao: SituacaoDoProduto;
}

export interface ArquivamentoDeProdutoDependencies {
  readonly autorizar: (request: Request) => Promise<
    | { readonly _tag: 'Autorizado'; readonly scope: VerifiedOrganizationScope }
    | { readonly _tag: 'Negado'; readonly response: NextResponse }
  >;
  readonly carregar: (scope: VerifiedOrganizationScope, id: string) => Promise<ProdutoParaArquivamento | null>;
  readonly bling: (scope: VerifiedOrganizationScope) => ProdutoNoBlingParaInativacao;
  readonly arquivarLocal: (scope: VerifiedOrganizationScope, id: string) => Promise<'arquivado' | 'ja_arquivado' | 'nao_encontrado'>;
  readonly correlationId: (request: Request) => string;
}

/** Só o `id`. `z.object` descarta qualquer outra chave do corpo. */
const corpoSchema = z.object({ id: z.string().uuid() });

function falha(error: string, status: number): NextResponse {
  return NextResponse.json({ success: false, error }, { status });
}

/** Frase pública de cada desfecho sem prova de que o produto saiu da venda no Bling. Nada do corpo do Bling. */
function respostaSemInativacaoRemota(desfecho: Exclude<DesfechoDaInativacaoRemota, { _tag: 'ForaDaVenda' }>): NextResponse {
  const mantido = 'O produto continua ativo no ORBITA.';
  switch (desfecho._tag) {
    case 'Recusada':
      return falha(`O Bling recusou tirar o produto da venda (HTTP ${desfecho.status}). ${mantido}`, 409);
    case 'Limitada':
      return falha(`O Bling está limitando as requisições no momento. ${mantido} Tente de novo em instantes.`, 503);
    case 'AindaAtivo':
      return falha(`O Bling não confirmou: o produto continua ativo lá. ${mantido}`, 409);
    case 'Indeterminada':
      return falha(`Não foi possível confirmar no Bling que o produto saiu da venda. ${mantido} Tente de novo.`, 503);
  }
}

export function createArquivamentoDeProdutoHandler(deps: ArquivamentoDeProdutoDependencies) {
  return async function arquivarProduto(request: Request): Promise<NextResponse> {
    const autorizacao = await deps.autorizar(request);
    if (autorizacao._tag === 'Negado') return autorizacao.response;
    const { scope } = autorizacao;
    const correlationId = deps.correlationId(request);
    const evento = (nome: string, detalhes: Readonly<Record<string, string | null>>) => {
      logger[nome.endsWith('.recusado') || nome.endsWith('.sem_prova') ? 'warn' : 'info'](nome, {
        subsystem: 'app', correlationId, organizacaoId: scope.organizationId, actorId: scope.actorId, ...detalhes,
      });
    };

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
    evento('produtos.arquivamento.iniciado', { produto: produto.id, situacao: produto.situacao });

    if (produto.situacao === 'arquivado') {
      evento('produtos.arquivamento.concluido', { produto: produto.id, desfecho: 'ja_arquivado' });
      return NextResponse.json({ success: true, message: 'O produto já estava arquivado.', arquivado: true, foraDaVendaNoBling: null });
    }

    if (produto.vinculo._tag === 'Ambiguo') {
      evento('produtos.arquivamento.recusado', { produto: produto.id, desfecho: 'VinculoAmbiguo' });
      return falha(
        'O vínculo deste produto com o Bling não é reconhecido, então não dá para confirmar que ele saiu da venda lá. '
          + 'O produto continua ativo no ORBITA. Sincronize o catálogo ou corrija o cadastro antes de arquivar.',
        409,
      );
    }

    let foraDaVendaNoBling: 'I' | 'E' | 'ausente' | null = null;
    if (produto.vinculo._tag === 'Bling') {
      const desfecho = await inativarProdutoNoBling(deps.bling(scope), produto.vinculo.blingId);
      if (desfecho._tag !== 'ForaDaVenda') {
        evento(desfecho._tag === 'Indeterminada' || desfecho._tag === 'Limitada' ? 'produtos.arquivamento.sem_prova' : 'produtos.arquivamento.recusado',
          { produto: produto.id, desfecho: desfecho._tag });
        return respostaSemInativacaoRemota(desfecho);
      }
      foraDaVendaNoBling = desfecho.situacaoRemota;
    }

    let resultado: Awaited<ReturnType<ArquivamentoDeProdutoDependencies['arquivarLocal']>>;
    try {
      resultado = await deps.arquivarLocal(scope, produto.id);
    } catch (erro: unknown) {
      registrarFalhaInterna('produtos.arquivamento.local', erro, { organizacaoId: scope.organizationId });
      return falha(
        produto.vinculo._tag === 'SoLocal'
          ? 'Não foi possível arquivar o produto no ORBITA. Tente de novo.'
          : 'O produto saiu da venda no Bling, mas o arquivamento no ORBITA falhou. Tente de novo para concluir.',
        500,
      );
    }
    if (resultado === 'nao_encontrado') return falha('Produto não encontrado.', 404);

    evento('produtos.arquivamento.concluido', { produto: produto.id, desfecho: resultado, bling: foraDaVendaNoBling });
    return NextResponse.json({ success: true, message: 'Produto arquivado.', arquivado: true, foraDaVendaNoBling });
  };
}
