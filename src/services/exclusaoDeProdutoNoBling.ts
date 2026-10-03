import type { EscritaRemota, ExclusaoRemota, LeituraRemota } from '../lib/integrations/bling/operacaoRemotaContract';

import { excluirComConfirmacao, type DesfechoDaExclusaoRemota } from './exclusaoRemotaConfirmada';

/** O que a exclusão de produto precisa do Bling. `BlingClient` satisfaz. */
export interface ProdutoNoBlingParaExclusao {
  marcarProdutoExcluido(id: string): Promise<EscritaRemota>;
  excluirProduto(id: string): Promise<ExclusaoRemota>;
  consultarProduto(id: string): Promise<LeituraRemota<unknown>>;
}

/**
 * Exclui o produto no Bling e só conclui o que as respostas provam.
 *
 * O Bling só exclui definitivamente produto na situação `E`: `DELETE` de
 * produto ativo responde 400, código 12 (provado em 2026-10-02). Então:
 *
 * 1. `PATCH /produtos/{id}/situacoes` → `E`;
 * 2. `DELETE /produtos/{id}`, com a regra de `excluirComConfirmacao`: resposta
 *    sem prova de efeito é decidida por uma leitura — `404` é ausência, `200`
 *    é "continua lá", qualquer outra coisa é indeterminado. Nunca um segundo
 *    `DELETE` às cegas.
 *
 * Se a mudança de situação não tiver prova de efeito (prazo, rede, 5xx) ou o
 * produto já não estiver lá (`404`), também é a leitura que decide: ausente é
 * exclusão concluída; presente ou sem prova encerra sem `DELETE`.
 */
export async function excluirProdutoNoBling(
  porta: ProdutoNoBlingParaExclusao,
  blingId: string,
): Promise<DesfechoDaExclusaoRemota> {
  const situacao = await porta.marcarProdutoExcluido(blingId);
  switch (situacao._tag) {
    case 'EscritaAceita':
      break;
    case 'RemotoRecusou':
      return { _tag: 'Recusada', status: situacao.status };
    case 'RemotoLimitado':
      return { _tag: 'Limitada' };
    case 'RemotoAusente':
    case 'RemotoIndeterminado': {
      const leitura = await porta.consultarProduto(blingId);
      if (leitura._tag === 'RemotoAusente') return { _tag: 'AusenciaConfirmada', comprovadaPor: 'consulta' };
      if (leitura._tag === 'RemotoPresente') return { _tag: 'RemotoAindaExiste' };
      return { _tag: 'Indeterminada' };
    }
  }

  return excluirComConfirmacao({
    excluir: () => porta.excluirProduto(blingId),
    consultar: () => porta.consultarProduto(blingId),
  });
}
