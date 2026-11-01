/**
 * Identidade local dos espelhos do Chatwoot (MSG-003A).
 *
 * O espelho é referenciado pelo UUID local (`id_local`). O id do Chatwoot
 * (`id_externo`) só tem sentido dentro de uma organização e de uma conexão:
 * duas instalações numeram a partir de 1. Este módulo é o único lugar fora do
 * adapter que traduz um no outro, e toda tradução recebe a organização e a
 * conexão já verificadas (assinatura do webhook ou sessão + adapter do sync).
 * Nenhuma busca por id remoto sem esse escopo.
 *
 * Linha legada sem conexão provada (quarentena do MSG-002) continua legível:
 * ela é encontrada pelo par organização + id remoto e adotada pela conexão na
 * próxima escrita; o gatilho da migration 85 confere a prova.
 */

export type RecursoChatwoot = 'contato' | 'conversa' | 'mensagem';

export const TABELA_DO_RECURSO = {
  contato: 'chatwoot_contacts',
  conversa: 'chatwoot_conversations',
  mensagem: 'chatwoot_messages',
} as const satisfies Record<RecursoChatwoot, string>;

/** Organização e conexão já verificadas no servidor. Nunca vêm do cliente. */
export interface EscopoDaConexaoChatwoot {
  readonly organizacaoId: string;
  readonly conexaoId: string;
}

/** Uma linha candidata, já filtrada por organização e por conexão (ou sem conexão). */
export interface CandidatoDeIdentidade {
  readonly idLocal: string;
  readonly conexaoId: string | null;
}

export type ResultadoDoStore<T> =
  | { readonly _tag: 'StoreOk'; readonly valor: T }
  | { readonly _tag: 'StoreFalhou'; readonly codigo: string | undefined };

/**
 * Porta de persistência dos espelhos. A implementação privilegiada filtra
 * sempre a organização e a conexão recebidas, mesmo ignorando a RLS.
 */
export interface EspelhoChatwootStore {
  /** Linhas da organização com o id remoto, na conexão do escopo ou ainda sem conexão. */
  buscarPorIdExterno(
    recurso: RecursoChatwoot,
    escopo: EscopoDaConexaoChatwoot,
    idExterno: string,
  ): Promise<ResultadoDoStore<readonly CandidatoDeIdentidade[]>>;
  /**
   * A conexão do UUID local dentro da organização: `null` se o UUID não é da
   * organização; `{ conexaoId: null }` se a linha ainda não tem conexão provada.
   */
  buscarConexaoPorIdLocal(
    recurso: RecursoChatwoot,
    organizacaoId: string,
    idLocal: string,
  ): Promise<ResultadoDoStore<{ readonly conexaoId: string | null } | null>>;
  /** O id remoto do UUID local, só na organização e na conexão do escopo. */
  buscarPorIdLocal(
    recurso: RecursoChatwoot,
    escopo: EscopoDaConexaoChatwoot,
    idLocal: string,
  ): Promise<ResultadoDoStore<string | null>>;
  inserir(recurso: RecursoChatwoot, linha: Readonly<Record<string, unknown>>): Promise<ResultadoDoStore<string>>;
  /**
   * Atualiza a linha do UUID local na organização, se ela for da conexão do
   * escopo ou ainda não tiver conexão. Devolve quantas linhas mudaram.
   */
  atualizar(
    recurso: RecursoChatwoot,
    escopo: EscopoDaConexaoChatwoot,
    idLocal: string,
    campos: Readonly<Record<string, unknown>>,
  ): Promise<ResultadoDoStore<number>>;
}

export type FalhaDeIdentidadeChatwoot =
  /** Nenhuma linha com esse id na organização e conexão. */
  | 'IdentidadeNaoEncontrada'
  /** Mais de uma linha candidata: nunca se escolhe uma. */
  | 'IdentidadeAmbigua'
  /** A linha é de outra conexão ou organização: o banco recusou trocar a sua instalação. */
  | 'IdentidadeDeOutraConexao'
  /** O pai do registro não está espelhado nesta conexão (evento fora de ordem). */
  | 'PaiNaoEspelhado'
  /** A linha existe, mas ainda não tem conexão provada (quarentena do MSG-002). */
  | 'ConexaoNaoComprovada'
  /** O banco recusou o vínculo com o pai ou com a conexão. */
  | 'VinculoRecusado'
  /** O banco não respondeu; nada foi concluído. */
  | 'StoreIndisponivel';

export type ResolucaoDeIdLocal =
  | { readonly _tag: 'IdLocalResolvido'; readonly idLocal: string; readonly legado: boolean }
  | { readonly _tag: 'IdLocalNaoResolvido'; readonly falha: FalhaDeIdentidadeChatwoot };

export type ResolucaoDeIdExterno =
  | { readonly _tag: 'IdExternoResolvido'; readonly idExterno: number }
  | { readonly _tag: 'IdExternoNaoResolvido'; readonly falha: FalhaDeIdentidadeChatwoot };

export type ResolucaoPorIdLocal =
  | {
      readonly _tag: 'IdLocalDaConexao';
      readonly escopo: EscopoDaConexaoChatwoot;
      readonly idExterno: number;
    }
  | { readonly _tag: 'IdLocalNaoTraduzido'; readonly falha: FalhaDeIdentidadeChatwoot };

/** Falha tipada que atravessa a camada de aplicação sem carregar ids nem conteúdo. */
export class FalhaDeIdentidadeChatwootError extends Error {
  constructor(
    readonly recurso: RecursoChatwoot,
    readonly falha: FalhaDeIdentidadeChatwoot,
  ) {
    super(`Identidade Chatwoot não resolvida (${recurso}: ${falha})`);
    this.name = 'FalhaDeIdentidadeChatwootError';
  }
}

/** UUID local do id remoto, na organização e na conexão do escopo. */
export async function resolverIdLocal(
  store: EspelhoChatwootStore,
  escopo: EscopoDaConexaoChatwoot,
  recurso: RecursoChatwoot,
  idExterno: number,
): Promise<ResolucaoDeIdLocal> {
  const busca = await store.buscarPorIdExterno(recurso, escopo, String(idExterno));
  if (busca._tag === 'StoreFalhou') return { _tag: 'IdLocalNaoResolvido', falha: 'StoreIndisponivel' };
  // O store já filtra; o filtro repetido aqui é a defesa contra um store que não filtre.
  const candidatos = busca.valor.filter((c) => c.conexaoId === escopo.conexaoId || c.conexaoId === null);
  if (candidatos.length !== busca.valor.length) return { _tag: 'IdLocalNaoResolvido', falha: 'IdentidadeDeOutraConexao' };
  if (candidatos.length === 0) return { _tag: 'IdLocalNaoResolvido', falha: 'IdentidadeNaoEncontrada' };
  if (candidatos.length > 1) return { _tag: 'IdLocalNaoResolvido', falha: 'IdentidadeAmbigua' };
  const [unico] = candidatos as [CandidatoDeIdentidade];
  return { _tag: 'IdLocalResolvido', idLocal: unico.idLocal, legado: unico.conexaoId === null };
}

/** Id remoto do UUID local, só se o UUID for da organização e da conexão do escopo. */
export async function resolverIdExterno(
  store: EspelhoChatwootStore,
  escopo: EscopoDaConexaoChatwoot,
  recurso: RecursoChatwoot,
  idLocal: string,
): Promise<ResolucaoDeIdExterno> {
  const busca = await store.buscarPorIdLocal(recurso, escopo, idLocal);
  if (busca._tag === 'StoreFalhou') return { _tag: 'IdExternoNaoResolvido', falha: 'StoreIndisponivel' };
  if (busca.valor === null) return { _tag: 'IdExternoNaoResolvido', falha: 'IdentidadeNaoEncontrada' };
  const idExterno = Number(busca.valor);
  if (!Number.isSafeInteger(idExterno)) return { _tag: 'IdExternoNaoResolvido', falha: 'IdentidadeAmbigua' };
  return { _tag: 'IdExternoResolvido', idExterno };
}

/**
 * A referência que chega do navegador é só o UUID local. A organização vem da
 * sessão verificada; a conexão é a da própria linha nessa organização, e o id
 * remoto sai do resolver nessa conexão. UUID de outra organização, adulterado
 * ou ainda sem conexão provada não é traduzido.
 */
export async function resolverPorIdLocal(
  store: EspelhoChatwootStore,
  organizacaoId: string,
  recurso: RecursoChatwoot,
  idLocal: string,
): Promise<ResolucaoPorIdLocal> {
  const conexao = await store.buscarConexaoPorIdLocal(recurso, organizacaoId, idLocal);
  if (conexao._tag === 'StoreFalhou') return { _tag: 'IdLocalNaoTraduzido', falha: 'StoreIndisponivel' };
  if (conexao.valor === null) return { _tag: 'IdLocalNaoTraduzido', falha: 'IdentidadeNaoEncontrada' };
  if (conexao.valor.conexaoId === null) return { _tag: 'IdLocalNaoTraduzido', falha: 'ConexaoNaoComprovada' };
  const escopo = { organizacaoId, conexaoId: conexao.valor.conexaoId };
  const externo = await resolverIdExterno(store, escopo, recurso, idLocal);
  if (externo._tag === 'IdExternoNaoResolvido') return { _tag: 'IdLocalNaoTraduzido', falha: externo.falha };
  return { _tag: 'IdLocalDaConexao', escopo, idExterno: externo.idExterno };
}
