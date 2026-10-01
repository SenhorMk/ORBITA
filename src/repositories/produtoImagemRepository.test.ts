import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it } from 'vitest';

import type { VerifiedOrganizationScope } from '../lib/verifiedOrganizationScope';
import { ProdutoImagemRepository } from './produtoImagemRepository';

const ORG = '11111111-1111-4111-8111-111111111111';
const OUTRA_ORG = '99999999-9999-4999-8999-999999999999';
const PRODUTO = '33333333-3333-4333-8333-333333333333';
const A = `${ORG}/${PRODUTO}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png`;
const B = `${ORG}/${PRODUTO}/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.png`;

/** SAFETY: o escopo é entrada do teste, não o que está sob teste. */
const escopo = (organizationId: string) => ({ organizationId, actorId: ORG, role: 'owner' } as unknown as VerifiedOrganizationScope);

type Linha = Record<string, unknown>;

/**
 * Um PostgREST em memória que APLICA os filtros `eq`/`is` que recebe — então o
 * teste prova quais linhas a consulta encontra, e não só que o filtro existe.
 */
function bancoEmMemoria(linhas: Linha[]) {
  const filtrosUsados: Array<Array<[string, string, unknown]>> = [];
  const cliente = {
    from(tabela: string) {
      expect(tabela).toBe('produtos');
      const filtros: Array<[string, string, unknown]> = [];
      filtrosUsados.push(filtros);
      let alteracao: Linha | null = null;
      const encontradas = () => linhas.filter((l) => filtros.every(([op, col, v]) => (op === 'is' ? (l[col] ?? null) === v : l[col] === v)));
      const builder = {
        select: () => (alteracao ? executarUpdate() : builder),
        update: (valores: Linha) => { alteracao = valores; return builder; },
        eq: (col: string, v: unknown) => { filtros.push(['eq', col, v]); return builder; },
        is: (col: string, v: unknown) => { filtros.push(['is', col, v]); return builder; },
        maybeSingle: async () => ({ data: encontradas()[0] ?? null, error: null }),
      };
      const executarUpdate = async () => {
        const alvo = encontradas();
        for (const l of alvo) Object.assign(l, alteracao);
        return { data: alvo.map((l) => ({ id: l.id })), error: null };
      };
      return builder;
    },
  };
  // SAFETY: o fake implementa só a cadeia de consulta que o repositório usa.
  return { cliente: cliente as unknown as SupabaseClient, filtrosUsados };
}

let linhas: Linha[];
let banco: ReturnType<typeof bancoEmMemoria>;
let repo: ProdutoImagemRepository;

beforeEach(() => {
  linhas = [
    { id: PRODUTO, organizacao_id: ORG, imagem_storage_path: A, imagem_url: 'https://bling/x.jpg' },
    { id: PRODUTO, organizacao_id: OUTRA_ORG, imagem_storage_path: null, imagem_url: null },
  ];
  banco = bancoEmMemoria(linhas);
  repo = new ProdutoImagemRepository(banco.cliente);
});

describe('ProdutoImagemRepository', () => {
  it('carrega por id E organização do escopo', async () => {
    expect(await repo.carregar(escopo(ORG), PRODUTO)).toEqual({ id: PRODUTO, imagemStoragePath: A, imagemDoBling: 'https://bling/x.jpg' });
    expect(banco.filtrosUsados[0]).toEqual([['eq', 'id', PRODUTO], ['eq', 'organizacao_id', ORG]]);
    expect(await repo.carregar(escopo('77777777-7777-4777-8777-777777777777'), PRODUTO)).toBeNull();
  });

  it('CAS troca só quando o banco ainda tem o valor anterior', async () => {
    expect(await repo.trocarCaminho(escopo(ORG), PRODUTO, A, B)).toBe(true);
    expect(linhas[0]!.imagem_storage_path).toBe(B);
    // Segunda troca partindo do mesmo `A`: a precondição já não vale.
    expect(await repo.trocarCaminho(escopo(ORG), PRODUTO, A, `${ORG}/${PRODUTO}/cccccccc-cccc-4ccc-8ccc-cccccccccccc.png`)).toBe(false);
    expect(linhas[0]!.imagem_storage_path).toBe(B);
  });

  it('precondição nula vira `is null`, não `eq null`', async () => {
    linhas[0]!.imagem_storage_path = null;
    expect(await repo.trocarCaminho(escopo(ORG), PRODUTO, null, B)).toBe(true);
    expect(banco.filtrosUsados.at(-1)).toContainEqual(['is', 'imagem_storage_path', null]);
  });

  it('a escrita é escopada: nunca toca a linha de mesmo id em outra organização', async () => {
    await repo.trocarCaminho(escopo(ORG), PRODUTO, A, null);
    expect(linhas[0]!.imagem_storage_path).toBeNull();
    expect(linhas[1]).toEqual({ id: PRODUTO, organizacao_id: OUTRA_ORG, imagem_storage_path: null, imagem_url: null });
    expect(banco.filtrosUsados.at(-1)).toContainEqual(['eq', 'organizacao_id', ORG]);
  });
});
