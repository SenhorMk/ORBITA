import { describe, expect, it } from 'vitest';
import { EspelhoChatwootFake } from '@/services/__testkit__/espelhoChatwootFake';
import {
  atualizarStatusDaConversa,
  gravarContato,
  gravarConversa,
  gravarMensagem,
  type DadosDaMensagem,
  type EscopoDeEscritaChatwoot,
} from '@/services/chatwoot/espelhoChatwoot';
import {
  FalhaDeIdentidadeChatwootError,
  resolverIdExterno,
  resolverIdLocal,
  resolverPorIdLocal,
} from '@/services/chatwoot/identidadeChatwoot';

const ORG_A = 'a0000000-0000-4000-8000-00000000000a';
const ORG_B = 'b0000000-0000-4000-8000-00000000000b';
const CONEXAO_A1 = 'a0000000-0000-4000-8000-0000000000a1';
const CONEXAO_A2 = 'a0000000-0000-4000-8000-0000000000a2';
const CONEXAO_B1 = 'b0000000-0000-4000-8000-0000000000b1';
const ATOR = '70000000-0000-4000-8000-000000000001';

const A1: EscopoDeEscritaChatwoot = { organizacaoId: ORG_A, conexaoId: CONEXAO_A1, atorId: ATOR };
const A2: EscopoDeEscritaChatwoot = { organizacaoId: ORG_A, conexaoId: CONEXAO_A2, atorId: ATOR };
const B1: EscopoDeEscritaChatwoot = { organizacaoId: ORG_B, conexaoId: CONEXAO_B1, atorId: ATOR };

const contato = (idExterno: number, nome: string) => ({
  idExterno, nome, email: null, telefone: null, telefoneNormalizado: null, avatarUrl: null,
});
const mensagem = (idExterno: number, conversaIdExterno: number, conteudo: string): DadosDaMensagem => ({
  idExterno, conversaIdExterno, conteudo, tipo: 'incoming', remetenteNome: null, remetenteId: null,
  remetenteTipo: null, criadaEm: '2026-10-26T12:00:00Z',
});

/** Contato 5 → conversa 50 → mensagem 500 numa conexão, como o webhook ou o sync gravam. */
async function arvore(store: EspelhoChatwootFake, escopo: EscopoDeEscritaChatwoot, texto: string) {
  const contatoIdLocal = await gravarContato(store, escopo, contato(5, `Contato ${texto}`));
  const conversaIdLocal = await gravarConversa(store, escopo, {
    idExterno: 50, contatoIdLocal, contatoIdExterno: 5, displayId: 1, status: 'open', inboxId: 1, canal: 'Channel::Api',
  });
  const mensagemIdLocal = await gravarMensagem(store, escopo, mensagem(500, 50, `mensagem de ${texto}`), 'sobrescrever');
  return { contatoIdLocal, conversaIdLocal, mensagemIdLocal };
}

async function falhaDe(promessa: Promise<unknown>) {
  try {
    await promessa;
  } catch (erro) {
    if (erro instanceof FalhaDeIdentidadeChatwootError) return { recurso: erro.recurso, falha: erro.falha };
    throw erro;
  }
  throw new Error('a gravação deveria ter falhado');
}

describe('instalações com o mesmo id remoto (modelo depois do MSG-004)', () => {
  it('A1, A2 e B1 gravam espelhos distintos por UUID, cada vínculo na sua conexão', async () => {
    const store = new EspelhoChatwootFake({ pkGlobal: false });
    const a1 = await arvore(store, A1, 'A1');
    const a2 = await arvore(store, A2, 'A2');
    const b1 = await arvore(store, B1, 'B1');

    const uuids = [a1, a2, b1].map((a) => a.mensagemIdLocal);
    expect(new Set(uuids).size).toBe(3);
    expect(store.linhas.contato).toHaveLength(3);
    for (const [escopo, ids, texto] of [[A1, a1, 'A1'], [A2, a2, 'A2'], [B1, b1, 'B1']] as const) {
      const msg = store.porIdLocal('mensagem', ids.mensagemIdLocal)!;
      expect(msg).toMatchObject({ organizacao_id: escopo.organizacaoId, conexao_id: escopo.conexaoId, content: `mensagem de ${texto}` });
      expect(msg.conversa_id_local).toBe(ids.conversaIdLocal);
      expect(store.porIdLocal('conversa', ids.conversaIdLocal)!.contato_id_local).toBe(ids.contatoIdLocal);
    }
  });

  it('o resolver traduz o mesmo id remoto para o UUID de cada conexão, e o UUID de volta só na sua', async () => {
    const store = new EspelhoChatwootFake({ pkGlobal: false });
    const a1 = await arvore(store, A1, 'A1');
    const b1 = await arvore(store, B1, 'B1');

    await expect(resolverIdLocal(store, A1, 'conversa', 50)).resolves.toEqual({ _tag: 'IdLocalResolvido', idLocal: a1.conversaIdLocal, legado: false });
    await expect(resolverIdLocal(store, B1, 'conversa', 50)).resolves.toEqual({ _tag: 'IdLocalResolvido', idLocal: b1.conversaIdLocal, legado: false });
    await expect(resolverIdExterno(store, A1, 'conversa', a1.conversaIdLocal)).resolves.toEqual({ _tag: 'IdExternoResolvido', idExterno: 50 });
    // Cross-tenant e outra conexão: o UUID de B não é traduzido no escopo de A.
    await expect(resolverIdExterno(store, A1, 'conversa', b1.conversaIdLocal)).resolves.toEqual({ _tag: 'IdExternoNaoResolvido', falha: 'IdentidadeNaoEncontrada' });
    await expect(resolverIdExterno(store, A2, 'conversa', a1.conversaIdLocal)).resolves.toEqual({ _tag: 'IdExternoNaoResolvido', falha: 'IdentidadeNaoEncontrada' });
  });

  it('o status de B não toca a conversa 50 de A', async () => {
    const store = new EspelhoChatwootFake({ pkGlobal: false });
    const a1 = await arvore(store, A1, 'A1');
    const b1 = await arvore(store, B1, 'B1');
    await expect(atualizarStatusDaConversa(store, B1, 50, 'resolved')).resolves.toEqual({ _tag: 'StatusAplicado', conversaIdLocal: b1.conversaIdLocal });
    expect(store.porIdLocal('conversa', a1.conversaIdLocal)!.status).toBe('open');
    expect(store.porIdLocal('conversa', b1.conversaIdLocal)!.status).toBe('resolved');
  });
});

describe('antes do MSG-004: o id global ainda é PK', () => {
  it('a segunda instalação com o mesmo id é recusada com falha tipada e A fica intacta', async () => {
    const store = new EspelhoChatwootFake();
    const a1 = await arvore(store, A1, 'A1');
    await expect(falhaDe(gravarContato(store, B1, contato(5, 'Contato B1')))).resolves.toEqual({ recurso: 'contato', falha: 'IdentidadeDeOutraConexao' });
    await expect(falhaDe(gravarContato(store, A2, contato(5, 'Contato A2')))).resolves.toEqual({ recurso: 'contato', falha: 'IdentidadeDeOutraConexao' });
    expect(store.linhas.contato).toHaveLength(1);
    expect(store.porIdLocal('contato', a1.contatoIdLocal)).toMatchObject({ organizacao_id: ORG_A, conexao_id: CONEXAO_A1, name: 'Contato A1' });
  });

  it('mensagem de B para a conversa 50 de A é PaiNaoEspelhado, sem ligar na conversa de A', async () => {
    const store = new EspelhoChatwootFake();
    await arvore(store, A1, 'A1');
    await expect(falhaDe(gravarMensagem(store, B1, mensagem(501, 50, 'intrusa'), 'sobrescrever'))).resolves.toEqual({ recurso: 'mensagem', falha: 'PaiNaoEspelhado' });
    expect(store.linhas.mensagem).toHaveLength(1);
  });

  it('o status de B não toca a conversa 50 de A: não espelhada nesta conexão', async () => {
    const store = new EspelhoChatwootFake();
    const a1 = await arvore(store, A1, 'A1');
    await expect(atualizarStatusDaConversa(store, B1, 50, 'resolved')).resolves.toEqual({ _tag: 'ConversaNaoEspelhada' });
    expect(store.porIdLocal('conversa', a1.conversaIdLocal)!.status).toBe('open');
  });
});

describe('duplicação, reprocessamento e ordem', () => {
  it('o mesmo evento duas vezes mantém uma linha e o mesmo UUID', async () => {
    const store = new EspelhoChatwootFake();
    const primeira = await arvore(store, A1, 'A1');
    const segunda = await arvore(store, A1, 'A1');
    expect(segunda).toEqual(primeira);
    expect([store.linhas.contato.length, store.linhas.conversa.length, store.linhas.mensagem.length]).toEqual([1, 1, 1]);
  });

  it('mensagem antes da conversa falha tipada sem gravar; o reprocessamento depois completa sem duplicar', async () => {
    const store = new EspelhoChatwootFake();
    await expect(falhaDe(gravarMensagem(store, A1, mensagem(500, 50, 'cedo'), 'preservar'))).resolves.toEqual({ recurso: 'mensagem', falha: 'PaiNaoEspelhado' });
    expect(store.linhas.mensagem).toHaveLength(0);

    await arvore(store, A1, 'A1');
    const reprocessada = await gravarMensagem(store, A1, mensagem(500, 50, 'cedo'), 'preservar');
    expect(store.linhas.mensagem).toHaveLength(1);
    expect(store.porIdLocal('mensagem', reprocessada)!.content).toBe('mensagem de A1');
  });

  it('message_updated antes de message_created: a criação atrasada não apaga a edição', async () => {
    const store = new EspelhoChatwootFake();
    await arvore(store, A1, 'A1');
    const editada = await gravarMensagem(store, A1, mensagem(600, 50, 'texto editado'), 'sobrescrever');
    const atrasada = await gravarMensagem(store, A1, mensagem(600, 50, 'texto original'), 'preservar');
    expect(atrasada).toBe(editada);
    expect(store.porIdLocal('mensagem', editada)!.content).toBe('texto editado');
  });

  it('status antes da conversa é ConversaNaoEspelhada e não cria nada', async () => {
    const store = new EspelhoChatwootFake();
    await expect(atualizarStatusDaConversa(store, A1, 77, 'resolved')).resolves.toEqual({ _tag: 'ConversaNaoEspelhada' });
    expect(store.linhas.conversa).toHaveLength(0);
  });
});

describe('concorrência (intercalação determinística)', () => {
  it('webhook e sync criando o mesmo contato: o perdedor relê e atualiza a linha do vencedor', async () => {
    const store = new EspelhoChatwootFake();
    let vencedor: string | null = null;
    store.antesDeInserir = () => {
      store.antesDeInserir = null;
      vencedor = store.semear('contato', { id: 5, organizacao_id: ORG_A, conexao_id: CONEXAO_A1, name: 'do webhook' });
    };
    const perdedor = await gravarContato(store, A1, contato(5, 'do sync'));
    expect(perdedor).toBe(vencedor);
    expect(store.linhas.contato).toHaveLength(1);
    expect(store.porIdLocal('contato', perdedor)!.name).toBe('do sync');
  });

  it('B cria o mesmo id enquanto A escreve: A recebe falha tipada, nunca a linha de B', async () => {
    const store = new EspelhoChatwootFake();
    store.antesDeInserir = () => {
      store.antesDeInserir = null;
      store.semear('contato', { id: 5, organizacao_id: ORG_B, conexao_id: CONEXAO_B1, name: 'de B' });
    };
    await expect(falhaDe(gravarContato(store, A1, contato(5, 'de A')))).resolves.toEqual({ recurso: 'contato', falha: 'IdentidadeDeOutraConexao' });
    expect(store.linhas.contato).toEqual([expect.objectContaining({ organizacao_id: ORG_B, name: 'de B' })]);
  });

  it('as escritas paralelas de duas organizações com os mesmos ids não se misturam', async () => {
    const store = new EspelhoChatwootFake({ pkGlobal: false });
    const [a, b] = await Promise.all([arvore(store, A1, 'A1'), arvore(store, B1, 'B1')]);
    expect(store.porIdLocal('mensagem', a.mensagemIdLocal)!.organizacao_id).toBe(ORG_A);
    expect(store.porIdLocal('mensagem', b.mensagemIdLocal)!.organizacao_id).toBe(ORG_B);
  });
});

describe('legado durante a transição', () => {
  it('linha do sync antigo sem conexão é adotada: mesmo UUID, mesma leitura legada por id', async () => {
    const store = new EspelhoChatwootFake();
    const legado = store.semear('contato', { id: 21, organizacao_id: ORG_A, conexao_id: null, name: 'Sync antigo' });
    await expect(resolverIdLocal(store, A1, 'contato', 21)).resolves.toEqual({ _tag: 'IdLocalResolvido', idLocal: legado, legado: true });

    const gravado = await gravarContato(store, A1, contato(21, 'Atualizado'));
    expect(gravado).toBe(legado);
    expect(store.linhas.contato).toHaveLength(1);
    // O leitor legado (por `id` + organização) vê a escrita nova na mesma linha.
    expect(store.linhas.contato.find((l) => l.id === 21 && l.organizacao_id === ORG_A)).toMatchObject({ conexao_id: CONEXAO_A1, name: 'Atualizado' });
  });

  it('linha legada sem conexão e a da conexão com o mesmo id: ambígua, nada é escolhido', async () => {
    const store = new EspelhoChatwootFake({ pkGlobal: false });
    store.semear('contato', { id: 5, organizacao_id: ORG_A, conexao_id: null, name: 'sem prova' });
    store.semear('contato', { id: 5, organizacao_id: ORG_A, conexao_id: CONEXAO_A1, name: 'de A1' });
    await expect(resolverIdLocal(store, A1, 'contato', 5)).resolves.toEqual({ _tag: 'IdLocalNaoResolvido', falha: 'IdentidadeAmbigua' });
    await expect(falhaDe(gravarContato(store, A1, contato(5, 'x')))).resolves.toEqual({ recurso: 'contato', falha: 'IdentidadeAmbigua' });
  });

  it('linha legada de outra organização com o mesmo id não é adotada', async () => {
    const store = new EspelhoChatwootFake();
    store.semear('contato', { id: 21, organizacao_id: ORG_B, conexao_id: null, name: 'legado de B' });
    await expect(falhaDe(gravarContato(store, A1, contato(21, 'de A')))).resolves.toEqual({ recurso: 'contato', falha: 'IdentidadeDeOutraConexao' });
    expect(store.linhas.contato[0]).toMatchObject({ organizacao_id: ORG_B, conexao_id: null, name: 'legado de B' });
  });

  it('conversa que aponta para contato de outra conexão é recusada pelo vínculo', async () => {
    const store = new EspelhoChatwootFake({ pkGlobal: false });
    const contatoDeA2 = await gravarContato(store, A2, contato(5, 'de A2'));
    await expect(falhaDe(gravarConversa(store, A1, {
      idExterno: 50, contatoIdLocal: contatoDeA2, contatoIdExterno: 5, displayId: null, status: 'open', inboxId: 1, canal: 'Channel::Api',
    }))).resolves.toEqual({ recurso: 'conversa', falha: 'VinculoRecusado' });
  });
});

describe('falhas do banco e entradas inválidas', () => {
  it('banco indisponível vira StoreIndisponivel, sem sucesso inventado', async () => {
    const store = new EspelhoChatwootFake();
    store.falharProxima = '08006';
    await expect(falhaDe(gravarContato(store, A1, contato(5, 'x')))).resolves.toEqual({ recurso: 'contato', falha: 'StoreIndisponivel' });
    expect(store.linhas.contato).toHaveLength(0);
  });

  it('UUID inexistente no resolver reverso não é traduzido', async () => {
    const store = new EspelhoChatwootFake();
    await expect(resolverIdExterno(store, A1, 'mensagem', 'c0000000-0000-4000-8000-000000000000')).resolves.toEqual({ _tag: 'IdExternoNaoResolvido', falha: 'IdentidadeNaoEncontrada' });
  });
});

describe('contraprovas: store que não filtra a conexão ou busca o id global', () => {
  it('sem filtro de conexão, o resolver recusa a linha de A2 em vez de escrever nela', async () => {
    const store = new EspelhoChatwootFake({ pkGlobal: false, semFiltroDeConexao: true });
    const a2 = await arvore(store, A2, 'A2');
    await expect(resolverIdLocal(store, A1, 'contato', 5)).resolves.toEqual({ _tag: 'IdLocalNaoResolvido', falha: 'IdentidadeDeOutraConexao' });
    await expect(falhaDe(gravarContato(store, A1, contato(5, 'de A1')))).resolves.toEqual({ recurso: 'contato', falha: 'IdentidadeDeOutraConexao' });
    expect(store.porIdLocal('contato', a2.contatoIdLocal)!.name).toBe('Contato A2');
  });

  it('com busca global, o id 5 de B nunca vira o contato de A', async () => {
    const store = new EspelhoChatwootFake({ pkGlobal: false, buscaGlobal: true });
    const b1 = await arvore(store, B1, 'B1');
    await expect(falhaDe(gravarContato(store, A1, contato(5, 'de A1')))).resolves.toEqual({ recurso: 'contato', falha: 'IdentidadeDeOutraConexao' });
    await expect(atualizarStatusDaConversa(store, A1, 50, 'resolved')).rejects.toBeInstanceOf(FalhaDeIdentidadeChatwootError);
    expect(store.porIdLocal('contato', b1.contatoIdLocal)!.name).toBe('Contato B1');
    expect(store.porIdLocal('conversa', b1.conversaIdLocal)!.status).toBe('open');
  });
});

describe('MSG-003B: tradução da referência do navegador (UUID local)', () => {
  it('o UUID de A2 resolve a conexão A2 e o id remoto dela; o de B não resolve na sessão de A', async () => {
    const store = new EspelhoChatwootFake({ pkGlobal: false });
    await arvore(store, A1, 'A1');
    const a2 = await arvore(store, A2, 'A2');
    const b1 = await arvore(store, B1, 'B1');
    await expect(resolverPorIdLocal(store, ORG_A, 'conversa', a2.conversaIdLocal)).resolves.toEqual({
      _tag: 'IdLocalDaConexao', escopo: { organizacaoId: ORG_A, conexaoId: CONEXAO_A2 }, idExterno: 50,
    });
    await expect(resolverPorIdLocal(store, ORG_A, 'conversa', b1.conversaIdLocal)).resolves.toEqual({ _tag: 'IdLocalNaoTraduzido', falha: 'IdentidadeNaoEncontrada' });
  });

  it('linha legada sem conexão provada não é traduzida; banco fora é StoreIndisponivel', async () => {
    const store = new EspelhoChatwootFake();
    const legado = store.semear('conversa', { id: 50, organizacao_id: ORG_A, conexao_id: null, contact_id: 5, status: 'open' });
    await expect(resolverPorIdLocal(store, ORG_A, 'conversa', legado)).resolves.toEqual({ _tag: 'IdLocalNaoTraduzido', falha: 'ConexaoNaoComprovada' });
    store.falharProxima = '08006';
    await expect(resolverPorIdLocal(store, ORG_A, 'conversa', legado)).resolves.toEqual({ _tag: 'IdLocalNaoTraduzido', falha: 'StoreIndisponivel' });
  });
});
