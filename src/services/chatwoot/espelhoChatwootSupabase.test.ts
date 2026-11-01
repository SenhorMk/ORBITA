import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { criarEspelhoChatwootSupabase } from '@/services/chatwoot/espelhoChatwootSupabase';

const ORG = 'a0000000-0000-4000-8000-00000000000a';
const CONEXAO = 'a0000000-0000-4000-8000-0000000000a1';
const ID_LOCAL = 'c0000000-0000-4000-8000-000000000001';
const ESCOPO = { organizacaoId: ORG, conexaoId: CONEXAO };

type Chamada = [string, ...unknown[]];

/** Cliente que grava a cadeia de chamadas e responde `resposta` no fim dela. */
function clienteGravador(resposta: { data: unknown; error: { code: string } | null }) {
  const chamadas: Chamada[] = [];
  const cadeia: Record<string, unknown> = {};
  for (const metodo of ['select', 'eq', 'or', 'insert', 'update', 'single', 'maybeSingle']) {
    cadeia[metodo] = (...args: unknown[]) => {
      chamadas.push([metodo, ...args]);
      return cadeia;
    };
  }
  cadeia.then = (resolve: (v: unknown) => void) => resolve(resposta);
  const cliente = {
    from: (tabela: string) => {
      chamadas.push(['from', tabela]);
      return cadeia;
    },
  } as unknown as SupabaseClient;
  return { cliente, chamadas };
}

describe('store Supabase dos espelhos: toda consulta leva organização e conexão', () => {
  it('busca por id remoto filtra organização, id e conexão do escopo (ou legado sem conexão)', async () => {
    const { cliente, chamadas } = clienteGravador({ data: [{ id_local: ID_LOCAL, conexao_id: CONEXAO }], error: null });
    const resultado = await criarEspelhoChatwootSupabase(cliente).buscarPorIdExterno('conversa', ESCOPO, '50');
    expect(resultado).toEqual({ _tag: 'StoreOk', valor: [{ idLocal: ID_LOCAL, conexaoId: CONEXAO }] });
    expect(chamadas).toEqual([
      ['from', 'chatwoot_conversations'],
      ['select', 'id_local, conexao_id'],
      ['eq', 'organizacao_id', ORG],
      ['eq', 'id_externo', '50'],
      ['or', `conexao_id.eq.${CONEXAO},conexao_id.is.null`],
    ]);
  });

  it('o reverso exige a conexão provada: sem o caso legado', async () => {
    const { cliente, chamadas } = clienteGravador({ data: { id_externo: '50' }, error: null });
    const resultado = await criarEspelhoChatwootSupabase(cliente).buscarPorIdLocal('mensagem', ESCOPO, ID_LOCAL);
    expect(resultado).toEqual({ _tag: 'StoreOk', valor: '50' });
    expect(chamadas).toContainEqual(['eq', 'organizacao_id', ORG]);
    expect(chamadas).toContainEqual(['eq', 'conexao_id', CONEXAO]);
    expect(chamadas).toContainEqual(['eq', 'id_local', ID_LOCAL]);
    expect(chamadas.some(([m]) => m === 'or')).toBe(false);
  });

  it('MSG-003B: a conexão de um UUID local é buscada só dentro da organização da sessão', async () => {
    const { cliente, chamadas } = clienteGravador({ data: { conexao_id: CONEXAO }, error: null });
    const resultado = await criarEspelhoChatwootSupabase(cliente).buscarConexaoPorIdLocal('conversa', ORG, ID_LOCAL);
    expect(resultado).toEqual({ _tag: 'StoreOk', valor: { conexaoId: CONEXAO } });
    expect(chamadas).toEqual([
      ['from', 'chatwoot_conversations'],
      ['select', 'conexao_id'],
      ['eq', 'organizacao_id', ORG],
      ['eq', 'id_local', ID_LOCAL],
      ['maybeSingle'],
    ]);
    const vazio = clienteGravador({ data: null, error: null });
    await expect(criarEspelhoChatwootSupabase(vazio.cliente).buscarConexaoPorIdLocal('conversa', ORG, ID_LOCAL)).resolves.toEqual({ _tag: 'StoreOk', valor: null });
    const adulterado = clienteGravador({ data: null, error: null });
    await expect(criarEspelhoChatwootSupabase(adulterado.cliente).buscarConexaoPorIdLocal('conversa', ORG, "x' or 1=1")).resolves.toEqual({ _tag: 'StoreFalhou', codigo: 'escopo_invalido' });
    expect(adulterado.chamadas).toEqual([]);
  });

  it('a atualização é pelo UUID local, dentro da organização e da conexão', async () => {
    const { cliente, chamadas } = clienteGravador({ data: [{ id_local: ID_LOCAL }], error: null });
    const resultado = await criarEspelhoChatwootSupabase(cliente).atualizar('contato', ESCOPO, ID_LOCAL, { name: 'x' });
    expect(resultado).toEqual({ _tag: 'StoreOk', valor: 1 });
    expect(chamadas).toEqual([
      ['from', 'chatwoot_contacts'],
      ['update', { name: 'x' }],
      ['eq', 'organizacao_id', ORG],
      ['eq', 'id_local', ID_LOCAL],
      ['or', `conexao_id.eq.${CONEXAO},conexao_id.is.null`],
      ['select', 'id_local'],
    ]);
  });

  it('escopo fora do formato UUID não chega ao filtro `or` (sem injeção de filtro)', async () => {
    const { cliente, chamadas } = clienteGravador({ data: [], error: null });
    const store = criarEspelhoChatwootSupabase(cliente);
    const malicioso = { organizacaoId: ORG, conexaoId: `${CONEXAO},organizacao_id.neq.${ORG}` };
    await expect(store.buscarPorIdExterno('contato', malicioso, '5')).resolves.toEqual({ _tag: 'StoreFalhou', codigo: 'escopo_invalido' });
    await expect(store.atualizar('contato', malicioso, ID_LOCAL, {})).resolves.toEqual({ _tag: 'StoreFalhou', codigo: 'escopo_invalido' });
    await expect(store.buscarPorIdLocal('contato', ESCOPO, 'nao-e-uuid')).resolves.toEqual({ _tag: 'StoreFalhou', codigo: 'escopo_invalido' });
    expect(chamadas).toEqual([]);
  });

  it('erro do banco devolve o SQLSTATE; resposta fora do contrato não vira sucesso', async () => {
    const comErro = clienteGravador({ data: null, error: { code: '23505' } });
    await expect(criarEspelhoChatwootSupabase(comErro.cliente).inserir('contato', { id: 5 })).resolves.toEqual({ _tag: 'StoreFalhou', codigo: '23505' });
    const torta = clienteGravador({ data: [{ id_local: 'x', conexao_id: CONEXAO }], error: null });
    await expect(criarEspelhoChatwootSupabase(torta.cliente).buscarPorIdExterno('contato', ESCOPO, '5')).resolves.toEqual({ _tag: 'StoreFalhou', codigo: 'resposta_invalida' });
  });
});
