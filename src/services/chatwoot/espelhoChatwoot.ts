import {
  FalhaDeIdentidadeChatwootError,
  resolverIdLocal,
  type EscopoDaConexaoChatwoot,
  type EspelhoChatwootStore,
  type FalhaDeIdentidadeChatwoot,
  type RecursoChatwoot,
} from '@/services/chatwoot/identidadeChatwoot';

/**
 * Escrita dos espelhos do Chatwoot pelo UUID local (MSG-003A), comum ao webhook
 * e ao sync. Cada gravação localiza a linha pelo resolver (organização +
 * conexão), atualiza pelo `id_local` e devolve o `id_local`. O id remoto entra
 * só como dado da linha; o vínculo com o pai é o UUID local do pai.
 *
 * A linha nova ainda leva `id`, `contact_id` e `conversation_id` como eco do id
 * remoto, sem papel de chave (MSG-004). O mesmo id em outra conexão ou
 * organização é outra linha; trocar a instalação de uma linha provada é
 * recusado pelo banco com `IdentidadeDeOutraConexao`, nunca fundido.
 */

export interface EscopoDeEscritaChatwoot extends EscopoDaConexaoChatwoot {
  /** Ator de auditoria (`user_id`). Nunca autoridade de organização. */
  readonly atorId: string;
}

export interface DadosDoContato {
  readonly idExterno: number;
  readonly nome: string;
  readonly email: string | null;
  readonly telefone: string | null;
  readonly telefoneNormalizado: string | null;
  readonly avatarUrl: string | null;
}

export interface DadosDaConversa {
  readonly idExterno: number;
  readonly contatoIdLocal: string;
  readonly contatoIdExterno: number;
  readonly displayId: number | null;
  readonly status: string;
  readonly inboxId: number | null;
  readonly canal: string;
}

export interface DadosDaMensagem {
  readonly idExterno: number;
  readonly conversaIdExterno: number;
  readonly conteudo: string;
  readonly tipo: 'incoming' | 'outgoing' | 'system' | 'template';
  readonly remetenteNome: string | null;
  readonly remetenteId: number | null;
  readonly remetenteTipo: string | null;
  readonly criadaEm: string;
}

/**
 * `sobrescrever`: o evento traz o estado atual (sync, `message_updated`).
 * `preservar`: o evento só cria (`message_created`); uma entrega atrasada não
 * apaga a edição que chegou antes dela.
 */
export type ModoDeGravacao = 'sobrescrever' | 'preservar';

/** Uma corrida perdida (outra escrita criou a linha) é resolvida relendo uma vez. */
const TENTATIVAS = 2;

function falhar(recurso: RecursoChatwoot, falha: FalhaDeIdentidadeChatwoot): never {
  throw new FalhaDeIdentidadeChatwootError(recurso, falha);
}

function falhaDaEscrita(codigo: string | undefined): FalhaDeIdentidadeChatwoot {
  // 23514: troca de instalação ou de organização; 23503: pai ou conexão de outra
  // instalação (gatilho da migration 85 e FKs compostas).
  if (codigo === '23514') return 'IdentidadeDeOutraConexao';
  if (codigo === '23503') return 'VinculoRecusado';
  return 'StoreIndisponivel';
}

async function gravar(
  store: EspelhoChatwootStore,
  escopo: EscopoDeEscritaChatwoot,
  recurso: RecursoChatwoot,
  idExterno: number,
  campos: Readonly<Record<string, unknown>>,
  modo: ModoDeGravacao,
): Promise<string> {
  const escopoDaConexao = { organizacaoId: escopo.organizacaoId, conexaoId: escopo.conexaoId };
  let colidiu = false;
  for (let tentativa = 0; tentativa < TENTATIVAS; tentativa++) {
    const resolucao = await resolverIdLocal(store, escopoDaConexao, recurso, idExterno);

    if (resolucao._tag === 'IdLocalResolvido') {
      if (modo === 'preservar' && !resolucao.legado) return resolucao.idLocal;
      // Linha legada sem conexão: a escrita a adota e o gatilho confere a prova.
      const mudancas = modo === 'preservar' ? { conexao_id: escopo.conexaoId } : { ...campos, conexao_id: escopo.conexaoId };
      const atualizacao = await store.atualizar(recurso, escopoDaConexao, resolucao.idLocal, mudancas);
      if (atualizacao._tag === 'StoreFalhou') falhar(recurso, falhaDaEscrita(atualizacao.codigo));
      if (atualizacao.valor === 1) return resolucao.idLocal;
      continue; // outra escrita adotou a linha entre a leitura e o update
    }

    if (resolucao.falha !== 'IdentidadeNaoEncontrada') falhar(recurso, resolucao.falha);

    const insercao = await store.inserir(recurso, {
      ...campos,
      id: idExterno,
      id_externo: String(idExterno),
      organizacao_id: escopo.organizacaoId,
      conexao_id: escopo.conexaoId,
      user_id: escopo.atorId,
    });
    if (insercao._tag === 'StoreOk') return insercao.valor;
    if (insercao.codigo !== '23505') falhar(recurso, falhaDaEscrita(insercao.codigo));
    // 23505: ou uma escrita concorrente desta conexão criou a linha (a releitura
    // a encontra), ou o id é de outra conexão/organização (a releitura não acha).
    colidiu = true;
  }
  return falhar(recurso, colidiu ? 'IdentidadeDeOutraConexao' : 'IdentidadeAmbigua');
}

export function gravarContato(
  store: EspelhoChatwootStore,
  escopo: EscopoDeEscritaChatwoot,
  dados: DadosDoContato,
): Promise<string> {
  return gravar(store, escopo, 'contato', dados.idExterno, {
    name: dados.nome,
    email: dados.email,
    phone_number: dados.telefone,
    phone_normalizado: dados.telefoneNormalizado,
    avatar_url: dados.avatarUrl,
    updated_at: new Date().toISOString(),
  }, 'sobrescrever');
}

export function gravarConversa(
  store: EspelhoChatwootStore,
  escopo: EscopoDeEscritaChatwoot,
  dados: DadosDaConversa,
): Promise<string> {
  return gravar(store, escopo, 'conversa', dados.idExterno, {
    contato_id_local: dados.contatoIdLocal,
    contact_id: dados.contatoIdExterno,
    display_id: dados.displayId,
    status: dados.status,
    inbox_id: dados.inboxId,
    channel: dados.canal,
    updated_at: new Date().toISOString(),
  }, 'sobrescrever');
}

/** Grava a mensagem na conversa desta conexão; conversa ausente é `PaiNaoEspelhado`. */
export async function gravarMensagem(
  store: EspelhoChatwootStore,
  escopo: EscopoDeEscritaChatwoot,
  dados: DadosDaMensagem,
  modo: ModoDeGravacao,
): Promise<string> {
  const conversa = await resolverIdLocal(store, escopo, 'conversa', dados.conversaIdExterno);
  if (conversa._tag === 'IdLocalNaoResolvido') {
    falhar('mensagem', conversa.falha === 'IdentidadeNaoEncontrada' ? 'PaiNaoEspelhado' : conversa.falha);
  }
  return gravar(store, escopo, 'mensagem', dados.idExterno, {
    conversa_id_local: conversa.idLocal,
    conversation_id: dados.conversaIdExterno,
    content: dados.conteudo,
    message_type: dados.tipo,
    sender_name: dados.remetenteNome,
    sender_id: dados.remetenteId,
    sender_type: dados.remetenteTipo,
    created_at: dados.criadaEm,
    updated_at: new Date().toISOString(),
  }, modo);
}

export type DesfechoDoStatus =
  | { readonly _tag: 'StatusAplicado'; readonly conversaIdLocal: string }
  | { readonly _tag: 'ConversaNaoEspelhada' }
  | { readonly _tag: 'ConexaoNaoComprovada' };

/**
 * Status de uma conversa desta conexão. Conversa ainda não espelhada não é
 * criada a partir de um evento de status: o próximo sync a traz. Conversa
 * legada sem conexão comprovada não muda: o evento de status não prova de qual
 * instalação ela veio.
 */
export async function atualizarStatusDaConversa(
  store: EspelhoChatwootStore,
  escopo: EscopoDaConexaoChatwoot,
  conversaIdExterno: number,
  status: string,
): Promise<DesfechoDoStatus> {
  const conversa = await resolverIdLocal(store, escopo, 'conversa', conversaIdExterno);
  if (conversa._tag === 'IdLocalNaoResolvido') {
    if (conversa.falha === 'IdentidadeNaoEncontrada') return { _tag: 'ConversaNaoEspelhada' };
    falhar('conversa', conversa.falha);
  }
  if (conversa.legado) return { _tag: 'ConexaoNaoComprovada' };
  const atualizacao = await store.atualizar('conversa', escopo, conversa.idLocal, {
    status,
    updated_at: new Date().toISOString(),
  }, { somenteConexaoProvada: true });
  if (atualizacao._tag === 'StoreFalhou') falhar('conversa', falhaDaEscrita(atualizacao.codigo));
  if (atualizacao.valor !== 1) falhar('conversa', 'IdentidadeAmbigua');
  return { _tag: 'StatusAplicado', conversaIdLocal: conversa.idLocal };
}
