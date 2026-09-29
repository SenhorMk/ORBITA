import type { ExclusaoRemota, LeituraRemota } from '../lib/integrations/bling/operacaoRemotaContract';

/**
 * Exclui um recurso no Bling e só conclui o que a resposta prova.
 *
 * Usada pela exclusão de contato e pelo cancelamento de despesa. A regra é uma
 * só para as duas, e é por isso que mora aqui:
 *
 * | Resposta do `DELETE`                 | O que se conclui                               |
 * |--------------------------------------|------------------------------------------------|
 * | `2xx`                                | ausência confirmada                            |
 * | `400`/`401`/`403` (recusa)           | nada mudou — `Recusada`                        |
 * | `429` depois do retry do adapter     | não processado — `Limitada`                    |
 * | `404`, `5xx`, prazo, rede, ACK perdido | **não se sabe**: lê o recurso antes de concluir |
 *
 * A leitura de confirmação decide: `404` é ausência confirmada, `200` é
 * "continua lá" e qualquer outra coisa é `Indeterminada`. **Nunca** um segundo
 * `DELETE`: repetir a ação destrutiva às cegas é exatamente o que esta função
 * existe para impedir.
 *
 * O `404` do próprio `DELETE` também passa pela leitura. Sozinho ele diz "não
 * achei isto aqui"; a leitura é o que transforma isso em fato sobre o recurso.
 */
export interface RecursoRemoto {
  excluir(): Promise<ExclusaoRemota>;
  consultar(): Promise<LeituraRemota<unknown>>;
}

export type DesfechoDaExclusaoRemota =
  | { readonly _tag: 'AusenciaConfirmada'; readonly comprovadaPor: 'exclusao' | 'consulta' }
  /** O `DELETE` não teve prova de efeito e a leitura mostrou o recurso ainda lá. */
  | { readonly _tag: 'RemotoAindaExiste' }
  | { readonly _tag: 'Recusada'; readonly status: number }
  | { readonly _tag: 'Limitada' }
  /** Nem a exclusão nem a leitura provaram o estado remoto. */
  | { readonly _tag: 'Indeterminada' };

export async function excluirComConfirmacao(recurso: RecursoRemoto): Promise<DesfechoDaExclusaoRemota> {
  const exclusao = await recurso.excluir();
  switch (exclusao._tag) {
    case 'ExclusaoAceita':
      return { _tag: 'AusenciaConfirmada', comprovadaPor: 'exclusao' };
    case 'RemotoRecusou':
      return { _tag: 'Recusada', status: exclusao.status };
    case 'RemotoLimitado':
      return { _tag: 'Limitada' };
    case 'RemotoAusente':
    case 'RemotoIndeterminado':
      return confirmarPorLeitura(recurso);
  }
}

async function confirmarPorLeitura(recurso: RecursoRemoto): Promise<DesfechoDaExclusaoRemota> {
  const leitura = await recurso.consultar();
  switch (leitura._tag) {
    case 'RemotoAusente':
      return { _tag: 'AusenciaConfirmada', comprovadaPor: 'consulta' };
    case 'RemotoPresente':
      return { _tag: 'RemotoAindaExiste' };
    default:
      // Uma leitura recusada ou limitada não diz nada sobre o efeito do
      // `DELETE` que ficou sem resposta: continua sem prova.
      return { _tag: 'Indeterminada' };
  }
}
