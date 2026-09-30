import { caminhoPertenceAoProduto } from '@/lib/config/produtoImagemContract';
import { registrarFalhaInterna } from '@/lib/observability/falhaInterna';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';

import type { ArmazenamentoDeImagemPort } from './armazenamentoDeImagem';

export type DesfechoDaLimpezaDaFoto = 'sem_foto' | 'concluida' | 'falhou' | 'recusada';

export interface ExclusaoDeProdutoComFotoDeps {
  /**
   * Exclui a linha escopada e devolve o `imagem_storage_path` que ELA tinha —
   * `ProdutoRepository.delete`, pelo `DELETE ... RETURNING`. Lança quando a
   * exclusão falha.
   */
  readonly excluirLinha: (scope: VerifiedOrganizationScope, produtoId: string) => Promise<string | null>;
  readonly armazenamento: Pick<ArmazenamentoDeImagemPort, 'remover'>;
}

/**
 * Exclui o produto local e, só depois, a foto do ORBITA que ele referenciava.
 *
 * - A exclusão do banco vem primeiro. Se ela lança, a exceção sobe intacta e o
 *   Storage não é tocado: o arquivo é preservado.
 * - O caminho removido é o que a própria linha excluída tinha, devolvido pelo
 *   banco. O navegador não participa, e o caminho passa de novo por
 *   `caminhoPertenceAoProduto` antes de chegar ao `remove`.
 * - Falha na remoção do objeto não ressuscita a linha nem vira falha da
 *   exclusão: vai para o log, e o desfecho diz `falhou`.
 */
export async function excluirProdutoComFoto(
  scope: VerifiedOrganizationScope,
  produtoId: string,
  deps: ExclusaoDeProdutoComFotoDeps,
): Promise<DesfechoDaLimpezaDaFoto> {
  const caminho = await deps.excluirLinha(scope, produtoId);
  if (caminho === null) return 'sem_foto';

  if (!caminhoPertenceAoProduto(caminho, scope.organizationId, produtoId)) {
    // A restrição da migration 70 torna isto impossível; se acontecer, o
    // objeto não é removido e o fato fica registrado.
    registrarFalhaInterna(
      'produtos.delete.limpeza_da_foto_recusada',
      new Error('caminho da foto fora do prefixo do produto'),
      { organizacaoId: scope.organizationId },
    );
    return 'recusada';
  }

  const remocao = await deps.armazenamento.remover([caminho]);
  if (remocao._tag === 'Removido') return 'concluida';
  registrarFalhaInterna('produtos.delete.limpeza_da_foto', remocao.causa, {
    organizacaoId: scope.organizationId,
    atorId: scope.actorId,
  });
  return 'falhou';
}
