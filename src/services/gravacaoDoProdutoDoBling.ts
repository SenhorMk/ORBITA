import type { VerifiedOrganizationScope } from '../lib/verifiedOrganizationScope';
import { situacaoLocalDaSituacaoBling } from '../lib/config/produtoContract';
import { produtoRepository, type ProdutoParaGravar } from '../repositories/produtoRepository';

/**
 * Grava no ORBITA um produto lido do Bling pela sincronização.
 *
 * Situação `E` (Excluído) vira tombstone e arquiva o produto local, como no
 * webhook (`exclusaoDeProduto.ts`): regravar faria o excluído voltar ativo.
 * As demais situações seguem o contrato de sempre (`A` ativo, `I` inativo;
 * ausente mantém, e arquivado fica — migration 75).
 */
export async function gravarProdutoDoBling(
  scope: VerifiedOrganizationScope,
  situacaoNoBling: unknown,
  produto: Omit<ProdutoParaGravar, 'situacao'>,
): Promise<void> {
  if (situacaoNoBling === 'E') {
    await produtoRepository.registrarExclusaoNoBling(scope, produto.bling_id, null);
    return;
  }
  await produtoRepository.upsert(scope, { ...produto, situacao: situacaoLocalDaSituacaoBling(situacaoNoBling) });
}
