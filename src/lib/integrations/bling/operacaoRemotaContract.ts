/**
 * O que uma leitura ou uma exclusão no Bling **prova** sobre o estado remoto.
 *
 * Existe para as operações destrutivas (excluir contato, excluir conta a
 * pagar) e para a leitura que as confirma. Nelas a pergunta não é "deu certo?",
 * e sim "o que eu sei sobre o recurso do outro lado depois desta chamada?" — e
 * há três respostas que não podem ser confundidas:
 *
 * - **o Bling recusou antes de agir** (`RemotoRecusou`, `RemotoLimitado`): nada
 *   mudou lá. A documentação do Bling diz que requisições acima do limite não
 *   são processadas, então o 429 que sobra depois da política de retry do
 *   adapter entra aqui;
 * - **o recurso existe / não existe** (`RemotoPresente`, `RemotoAusente`,
 *   `ExclusaoAceita`): fato provado por uma resposta válida;
 * - **não dá para saber** (`RemotoIndeterminado`): prazo esgotado, rede, 5xx
 *   ou resposta ilegível. A exclusão pode ter acontecido — quem chama só pode
 *   concluir algo depois de ler o recurso de novo.
 *
 * Nenhuma variante carrega corpo do provedor nem credencial.
 */

/** Por que o resultado ficou sem prova. Vocabulário fechado, nosso. */
export type CausaIndeterminada = 'prazo_esgotado' | 'falha_de_rede' | 'erro_do_servidor' | 'resposta_invalida';

export type FalhaDeOperacaoRemota =
  /** Recusa definitiva (400, 401, 403 e demais 4xx de validação): nada mudou. */
  | { readonly _tag: 'RemotoRecusou'; readonly status: number }
  /** O limite de requisições persistiu depois do retry do adapter: não processado. */
  | { readonly _tag: 'RemotoLimitado' }
  /** Pode ou não ter tido efeito. */
  | { readonly _tag: 'RemotoIndeterminado'; readonly causa: CausaIndeterminada };

/** Leitura de um recurso por id: `404` é resposta, não falha de transporte. */
export type LeituraRemota<T> =
  | { readonly _tag: 'RemotoPresente'; readonly valor: T }
  | { readonly _tag: 'RemotoAusente' }
  | FalhaDeOperacaoRemota;

/** Exclusão de um recurso por id. */
export type ExclusaoRemota =
  /** `2xx`: o Bling confirmou a exclusão. */
  | { readonly _tag: 'ExclusaoAceita' }
  /** `404`: o recurso não estava lá. Só vale como ausência depois de uma leitura. */
  | { readonly _tag: 'RemotoAusente' }
  | FalhaDeOperacaoRemota;

/** Contato lido por id: só o que a confirmação precisa. */
export interface ContatoRemoto {
  readonly id: string;
}
