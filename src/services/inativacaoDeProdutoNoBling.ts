import type { EscritaRemota, LeituraRemota, ProdutoRemoto } from '../lib/integrations/bling/operacaoRemotaContract';

/** O que o arquivamento precisa do Bling. `BlingClient` satisfaz. */
export interface ProdutoNoBlingParaInativacao {
  marcarProdutoInativo(id: string): Promise<EscritaRemota>;
  consultarProduto(id: string): Promise<LeituraRemota<Pick<ProdutoRemoto, 'situacao'>>>;
}

/** O que o Bling provou sobre tirar o produto da venda. Só `ForaDaVenda` libera o arquivamento local. */
export type DesfechoDaInativacaoRemota =
  | {
      readonly _tag: 'ForaDaVenda';
      readonly comprovadaPor: 'escrita' | 'consulta';
      /** `I` inativo, `E` excluído no Bling, ou `ausente` (404 confirmado pela leitura). */
      readonly situacaoRemota: 'I' | 'E' | 'ausente';
    }
  /** A escrita ficou sem prova e a leitura mostrou o produto ainda ativo. */
  | { readonly _tag: 'AindaAtivo' }
  | { readonly _tag: 'Recusada'; readonly status: number }
  | { readonly _tag: 'Limitada' }
  /** Nem a escrita nem a leitura provaram o estado remoto. */
  | { readonly _tag: 'Indeterminada' };

/**
 * Tira o produto da venda no Bling e só conclui o que as respostas provam.
 *
 * `PATCH /produtos/{id}/situacoes` com `I` (inativo) — nunca `E` nem `DELETE`:
 * arquivar não destrói o cadastro nem o histórico de vendas no ERP, e repetir
 * é seguro (marcar inativo de novo não muda nada).
 *
 * | Resposta do `PATCH`                     | O que se conclui                         |
 * |-----------------------------------------|------------------------------------------|
 * | `2xx`                                   | fora da venda                            |
 * | `400`/`401`/`403` (recusa)              | nada mudou — `Recusada`                  |
 * | `429` depois do retry do adapter        | não processado — `Limitada`              |
 * | `404`, `5xx`, prazo, rede, ACK perdido  | **não se sabe**: lê o produto e decide   |
 *
 * A leitura decide: `I` ou `E` é fora da venda; `404` é ausência (fora da
 * venda também); `A` é "ainda ativo"; qualquer outra coisa é indeterminado.
 * Nunca um segundo `PATCH` às cegas.
 *
 * @param porta - O Bling da organização.
 * @param blingId - O id do produto no Bling, lido do banco.
 * @returns O desfecho provado.
 */
export async function inativarProdutoNoBling(
  porta: ProdutoNoBlingParaInativacao,
  blingId: string,
): Promise<DesfechoDaInativacaoRemota> {
  const escrita = await porta.marcarProdutoInativo(blingId);
  switch (escrita._tag) {
    case 'EscritaAceita':
      return { _tag: 'ForaDaVenda', comprovadaPor: 'escrita', situacaoRemota: 'I' };
    case 'RemotoRecusou':
      return { _tag: 'Recusada', status: escrita.status };
    case 'RemotoLimitado':
      return { _tag: 'Limitada' };
    case 'RemotoAusente':
    case 'RemotoIndeterminado':
      break;
  }

  const leitura = await porta.consultarProduto(blingId);
  if (leitura._tag === 'RemotoAusente') return { _tag: 'ForaDaVenda', comprovadaPor: 'consulta', situacaoRemota: 'ausente' };
  if (leitura._tag !== 'RemotoPresente') return { _tag: 'Indeterminada' };
  const { situacao } = leitura.valor;
  if (situacao === 'I' || situacao === 'E') return { _tag: 'ForaDaVenda', comprovadaPor: 'consulta', situacaoRemota: situacao };
  if (situacao === 'A') return { _tag: 'AindaAtivo' };
  return { _tag: 'Indeterminada' };
}
