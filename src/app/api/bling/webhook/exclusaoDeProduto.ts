import { z } from 'zod';
import { produtoRepository, type DesfechoDaExclusaoNoBling } from '../../../../repositories/produtoRepository';
import { logger } from '../../../../lib/observability/logger';
import type { VerifiedOrganizationScope } from '../../../../lib/verifiedOrganizationScope';
import { dataDoEventoDoBling, idDoBlingSchema } from './eventoDoBling';

/** `data` do evento de produto: o id vem em `produto.id`, `id`, `idProduto` ou `bling_id`. */
const dadosDoProdutoSchema = z
  .object({
    produto: z.object({ id: z.unknown() }).partial().optional(),
    id: z.unknown(),
    idProduto: z.unknown(),
    bling_id: z.unknown(),
  })
  .partial()
  .transform((d) => d.produto?.id ?? d.id ?? d.idProduto ?? d.bling_id)
  .pipe(idDoBlingSchema);


/**
 * `product.deleted` (ou `produto.excluido`): o recurso antes do ponto é
 * exatamente produto. `product_supplier.deleted` e `stock.deleted` não são
 * exclusão do produto — o id deles é de outro recurso.
 */
export function ehExclusaoDeProduto(entity: string): boolean {
  const [recurso, acao = ''] = entity.split('.');
  return (recurso === 'product' || recurso === 'produto')
    && (acao.includes('delet') || acao.includes('exclu') || acao.includes('remov'));
}

/** O `bling_id` do produto do evento, quando é um id numérico do Bling; senão `null`. */
export function blingIdDoProduto(eventData: Record<string, unknown>): string | null {
  const parsed = dadosDoProdutoSchema.safeParse(eventData);
  return parsed.success ? parsed.data : null;
}

export type ExclusaoDeProduto =
  | { readonly _tag: 'Registrada'; readonly blingId: string; readonly desfecho: DesfechoDaExclusaoNoBling }
  | { readonly _tag: 'Ignorada'; readonly reason: 'id_invalido' };

/**
 * Aplica a exclusão de produto feita no Bling (PRE-004) como tombstone: sem
 * GET de detalhe e sem upsert. O produto local é arquivado, não apagado, e o
 * banco recusa qualquer gravação posterior que o recrie. A reentrega responde
 * `ja_registrado` sem efeito novo; uma falha do banco sobe para o inbox
 * marcar `failed` e o Bling reentregar.
 *
 * @param correlationId - A chave de idempotência do evento no inbox.
 */
export async function aplicarExclusaoDeProduto(
  eventRecord: Record<string, unknown>,
  eventData: Record<string, unknown>,
  organizationScope: VerifiedOrganizationScope,
  correlationId: string,
): Promise<ExclusaoDeProduto> {
  const contexto = { subsystem: 'provider' as const, provider: 'bling', correlationId, organizacaoId: organizationScope.organizationId };
  const blingId = blingIdDoProduto(eventData);
  if (!blingId) {
    logger.warn('bling_webhook.produto_excluido.recusado', { ...contexto, outcome: 'id_invalido' });
    return { _tag: 'Ignorada', reason: 'id_invalido' };
  }
  const desfecho = await produtoRepository.registrarExclusaoNoBling(organizationScope, blingId, dataDoEventoDoBling(eventRecord));
  logger.info('bling_webhook.produto_excluido.registrado', { ...contexto, blingId, outcome: desfecho });
  return { _tag: 'Registrada', blingId, desfecho };
}
