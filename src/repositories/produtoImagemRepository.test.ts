import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it } from 'vitest';

import { estadoDaFotoNoBling } from '../lib/config/produtoImagemContract';
import type { VerifiedOrganizationScope } from '../lib/verifiedOrganizationScope';
import { comImagemEfetiva } from '../services/imagemEfetivaDoProduto';
import type { Produto } from '../types';
import { ProdutoImagemRepository } from './produtoImagemRepository';

const ORG = '11111111-1111-4111-8111-111111111111';
const OUTRA_ORG = '99999999-9999-4999-8999-999999999999';
const PRODUTO = '33333333-3333-4333-8333-333333333333';
const A = `${ORG}/${PRODUTO}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png`;
const B = `${ORG}/${PRODUTO}/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.png`;
const LEASE = '44444444-4444-4444-8444-444444444444';

/** SAFETY: o escopo é entrada do teste, não o que está sob teste. */
const escopo = (organizationId: string) => ({ organizationId, actorId: ORG, role: 'owner' } as unknown as VerifiedOrganizationScope);

type Linha = Record<string, unknown>;

/**
 * Um PostgREST em memória que APLICA os filtros `eq`/`is` que recebe — então o
 * teste prova quais linhas a consulta encontra, e não só que o filtro existe.
 */
function bancoEmMemoria(linhas: Linha[]) {
  const filtrosUsados: Array<Array<[string, string, unknown]>> = [];
  const rpcs: Array<{ nome: string; args: Record<string, unknown> }> = [];
  let respostaRpc: { data: unknown; error: unknown } = { data: true, error: null };
  const cliente = {
    async rpc(nome: string, args: Record<string, unknown>) { rpcs.push({ nome, args }); return respostaRpc; },
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
  return {
    cliente: cliente as unknown as SupabaseClient,
    filtrosUsados,
    rpcs,
    responderRpc(r: { data: unknown; error: unknown }) { respostaRpc = r; },
  };
}

let linhas: Linha[];
let banco: ReturnType<typeof bancoEmMemoria>;
let repo: ProdutoImagemRepository;

beforeEach(() => {
  linhas = [
    { id: PRODUTO, organizacao_id: ORG, bling_id: '777', imagem_storage_path: A, imagem_bling_sync_path: null, imagem_url: 'https://bling/x.jpg', imagem_bling_sync_lease_token: LEASE },
    { id: PRODUTO, organizacao_id: OUTRA_ORG, imagem_storage_path: null, imagem_url: null },
  ];
  banco = bancoEmMemoria(linhas);
  repo = new ProdutoImagemRepository(banco.cliente);
});

describe('ProdutoImagemRepository', () => {
  it('carrega por id E organização do escopo', async () => {
    expect(await repo.carregar(escopo(ORG), PRODUTO)).toEqual({
      id: PRODUTO, blingId: '777', imagemStoragePath: A, imagemBlingSyncPath: null, gerenciada: false, divergente: false, imagemDoBling: 'https://bling/x.jpg',
    });
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

  it('remoção com pendenteNoBling grava os dois campos na mesma instrução, com a mesma precondição', async () => {
    expect(await repo.trocarCaminho(escopo(ORG), PRODUTO, A, null, { pendenteNoBling: A })).toBe(true);
    expect(linhas[0]).toMatchObject({ imagem_storage_path: null, imagem_bling_sync_path: A });
    expect(banco.filtrosUsados.at(-1)).toEqual([['eq', 'id', PRODUTO], ['eq', 'organizacao_id', ORG], ['eq', 'imagem_storage_path', A]]);
    // Precondição falhou: nenhum dos dois muda.
    linhas[0]!.imagem_storage_path = B;
    linhas[0]!.imagem_bling_sync_path = null;
    expect(await repo.trocarCaminho(escopo(ORG), PRODUTO, A, null, { pendenteNoBling: A })).toBe(false);
    expect(linhas[0]).toMatchObject({ imagem_storage_path: B, imagem_bling_sync_path: null });
  });

  it('sem pendenteNoBling a troca não toca o estado confirmado', async () => {
    linhas[0]!.imagem_bling_sync_path = A;
    await repo.trocarCaminho(escopo(ORG), PRODUTO, A, B);
    expect(linhas[0]).toMatchObject({ imagem_storage_path: B, imagem_bling_sync_path: A });
  });

  it('confirmarSincronizacao marca o desejado só se ele ainda for o desejado (resposta atrasada de A não marca B)', async () => {
    // A linha já está em B: a sincronização de A chega atrasada.
    linhas[0]!.imagem_storage_path = B;
    expect(await repo.confirmarSincronizacao(escopo(ORG), PRODUTO, A, LEASE)).toBe(false);
    expect(linhas[0]!.imagem_bling_sync_path).toBeNull();
    expect(banco.filtrosUsados.at(-1)).toEqual([
      ['eq', 'id', PRODUTO], ['eq', 'organizacao_id', ORG], ['eq', 'imagem_bling_sync_lease_token', LEASE], ['eq', 'imagem_storage_path', A],
    ]);

    expect(await repo.confirmarSincronizacao(escopo(ORG), PRODUTO, B, LEASE)).toBe(true);
    expect(linhas[0]!.imagem_bling_sync_path).toBe(B);
    // Confirmar uma foto não mexe no espelho.
    expect(linhas[0]!.imagem_url).toBe('https://bling/x.jpg');
  });

  it('confirmar a remoção exige o desejado ainda nulo (is null) e nunca alcança outra organização', async () => {
    linhas[0]!.imagem_storage_path = null;
    linhas[0]!.imagem_bling_sync_path = A;
    expect(await repo.confirmarSincronizacao(escopo(ORG), PRODUTO, null, LEASE)).toBe(true);
    expect(linhas[0]!.imagem_bling_sync_path).toBeNull();
    // O Bling foi lido sem imagens: o espelho também esvazia, e a foto removida não volta por ele.
    expect(linhas[0]!.imagem_url).toBeNull();
    expect(banco.filtrosUsados.at(-1)).toContainEqual(['is', 'imagem_storage_path', null]);
    expect(linhas[1]).toEqual({ id: PRODUTO, organizacao_id: OUTRA_ORG, imagem_storage_path: null, imagem_url: null });
  });

  it('confirmar exige o lease desta execução: quem perdeu o lease não marca', async () => {
    expect(await repo.confirmarSincronizacao(escopo(ORG), PRODUTO, A, '55555555-5555-4555-8555-555555555555')).toBe(false);
    expect(linhas[0]!.imagem_bling_sync_path).toBeNull();
  });

  it('adquirir o lease: uma RPC escopada pela organização do escopo, com o TTL de 90 s', async () => {
    expect(await repo.adquirirLease(escopo(ORG), PRODUTO, LEASE)).toBe(true);
    expect(banco.rpcs).toEqual([{ nome: 'adquirir_lease_da_foto_no_bling', args: { p_organizacao_id: ORG, p_produto_id: PRODUTO, p_token: LEASE, p_ttl_segundos: 90 } }]);
    banco.responderRpc({ data: false, error: null });
    expect(await repo.adquirirLease(escopo(ORG), PRODUTO, LEASE)).toBe(false);
    banco.responderRpc({ data: null, error: { message: 'fora' } });
    await expect(repo.adquirirLease(escopo(ORG), PRODUTO, LEASE)).rejects.toEqual({ message: 'fora' });
  });

  it('liberar o lease: só pelo token, escopado pela organização', async () => {
    expect(await repo.liberarLease(escopo(ORG), PRODUTO, LEASE)).toBe(true);
    expect(banco.rpcs).toEqual([{ nome: 'liberar_lease_da_foto_no_bling', args: { p_organizacao_id: ORG, p_produto_id: PRODUTO, p_token: LEASE } }]);
    banco.responderRpc({ data: false, error: null });
    expect(await repo.liberarLease(escopo(ORG), PRODUTO, 'outro')).toBe(false);
  });

  it('só um id numérico do Bling é vínculo', async () => {
    const { blingIdDoVinculo } = await import('./produtoImagemRepository');
    expect(blingIdDoVinculo('16714230397')).toBe('16714230397');
    expect(blingIdDoVinculo(16714230397)).toBe('16714230397');
    for (const invalido of ['LOCAL-1', '', null, undefined, ' ', '12a']) expect(blingIdDoVinculo(invalido)).toBeNull();
  });
});

describe('autoridade da imagem: a primeira foto confirmada adota, e nada devolve', () => {
  it('primeiro CAS vencedor adota na MESMA instrução que aponta para a foto', async () => {
    linhas[0]!.imagem_storage_path = null;
    expect(await repo.trocarCaminho(escopo(ORG), PRODUTO, null, A)).toBe(true);
    expect(linhas[0]).toMatchObject({ imagem_storage_path: A, imagem_bling_gerenciada_pelo_orbita: true });
    // Uma única chamada de update, com os dois campos e a precondição do CAS.
    expect(banco.filtrosUsados).toHaveLength(1);
  });

  it('CAS perdido não adota', async () => {
    linhas[0]!.imagem_storage_path = B;
    expect(await repo.trocarCaminho(escopo(ORG), PRODUTO, null, A)).toBe(false);
    expect(linhas[0]!.imagem_bling_gerenciada_pelo_orbita).toBeUndefined();
  });

  it('outra organização não adota nem altera a propriedade', async () => {
    expect(await repo.trocarCaminho(escopo(OUTRA_ORG), PRODUTO, A, B)).toBe(false);
    expect(linhas[0]!.imagem_bling_gerenciada_pelo_orbita).toBeUndefined();
    expect(linhas[1]).not.toHaveProperty('imagem_bling_gerenciada_pelo_orbita');
  });

  it('troca mantém; remoção local não toca; remoção confirmada não toca', async () => {
    await repo.trocarCaminho(escopo(ORG), PRODUTO, A, B);
    expect(linhas[0]!.imagem_bling_gerenciada_pelo_orbita).toBe(true);
    await repo.trocarCaminho(escopo(ORG), PRODUTO, B, null, { pendenteNoBling: B });
    expect(linhas[0]!.imagem_bling_gerenciada_pelo_orbita).toBe(true);
    linhas[0]!.imagem_bling_sync_lease_token = LEASE;
    expect(await repo.confirmarSincronizacao(escopo(ORG), PRODUTO, null, LEASE)).toBe(true);
    expect(linhas[0]!.imagem_bling_gerenciada_pelo_orbita).toBe(true);
  });

  it('a confirmação limpa o drift registrado', async () => {
    linhas[0]!.imagem_bling_divergencia_detectada_em = '2026-10-02T12:00:00Z';
    await repo.confirmarSincronizacao(escopo(ORG), PRODUTO, A, LEASE);
    expect(linhas[0]!.imagem_bling_divergencia_detectada_em).toBeNull();
  });

  it('registrar drift: uma RPC escopada pela organização, pelo bling_id', async () => {
    expect(await repo.registrarDivergencia(escopo(ORG), '777')).toBe(true);
    expect(banco.rpcs).toEqual([{ nome: 'registrar_divergencia_da_foto_no_bling', args: { p_organizacao_id: ORG, p_bling_id: '777' } }]);
  });
});

describe('ciclo completo: adotar, remover e um webhook atrasado não ressuscitam a imagem do Bling', () => {
  const X = 'https://orgbling.s3.amazonaws.com/org/x.jpg';
  const assinar = { async assinarLeituras(caminhos: readonly string[]) {
    return { _tag: 'Assinadas' as const, urls: new Map(caminhos.map((c) => [c, `https://storage.test/sign/${c}`])) };
  } };
  const efetiva = async () => (await comImagemEfetiva(escopo(ORG), [linhas[0] as unknown as Produto], assinar))[0]!.imagem_url;
  const estado = async () => {
    const p = (await repo.carregar(escopo(ORG), PRODUTO))!;
    return estadoDaFotoNoBling({
      blingId: p.blingId, gerenciada: p.gerenciada, desejado: p.imagemStoragePath, confirmado: p.imagemBlingSyncPath, divergente: p.divergente,
    });
  };

  it('do Bling-dono ao ORBITA-dono, e a autoridade fica com o ORBITA depois da remoção', async () => {
    // 1–3. Nunca adotou; o Bling tem X; a tela mostra X.
    Object.assign(linhas[0]!, { imagem_storage_path: null, imagem_bling_sync_path: null, imagem_url: X, imagem_bling_gerenciada_pelo_orbita: false });
    expect(await efetiva()).toBe(X);
    expect(await estado()).toBe('sem_foto');

    // 4–6. Envia A pelo ORBITA: adota; A é sincronizada.
    await repo.trocarCaminho(escopo(ORG), PRODUTO, null, A);
    expect(linhas[0]!.imagem_bling_gerenciada_pelo_orbita).toBe(true);
    linhas[0]!.imagem_bling_sync_lease_token = LEASE;
    await repo.confirmarSincronizacao(escopo(ORG), PRODUTO, A, LEASE);
    expect(await estado()).toBe('sincronizada');
    expect(await efetiva()).toBe(`https://storage.test/sign/${A}`);

    // 7. Remove A: remoção pendente, sem fallback para o espelho.
    await repo.trocarCaminho(escopo(ORG), PRODUTO, A, null);
    expect(await estado()).toBe('pendente');
    expect(await efetiva()).toBeUndefined();

    // 8. Remoção confirmada: null/null, gerenciada continua true, espelho null.
    await repo.confirmarSincronizacao(escopo(ORG), PRODUTO, null, LEASE);
    expect(linhas[0]).toMatchObject({
      imagem_storage_path: null, imagem_bling_sync_path: null, imagem_url: null, imagem_bling_gerenciada_pelo_orbita: true,
    });
    expect(await estado()).toBe('sincronizada');

    // 9–12. Webhook (ou sincronização) atrasado regrava o espelho com X: a
    // imagem efetiva continua nenhuma, e a autoridade continua do ORBITA.
    linhas[0]!.imagem_url = X;
    expect(await efetiva()).toBeUndefined();
    expect(await estado()).toBe('sincronizada');
    expect(linhas[0]!.imagem_bling_gerenciada_pelo_orbita).toBe(true);
  });
});
