import { NextResponse } from 'next/server';
import { beforeEach, describe, expect, it } from 'vitest';

import type { EscritaRemota, ExclusaoRemota, LeituraRemota } from '@/lib/integrations/bling/operacaoRemotaContract';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';

import { createExclusaoDeProdutoHandler, type ExclusaoDeProdutoDependencies } from './handler';

/**
 * Exclusão de produto: Bling primeiro e confirmado, depois o ORBITA.
 *
 * O Bling falso reproduz o que a conta Bling provou em 2026-10-02: `DELETE` de
 * produto que não está na situação `E` é recusado (400, código 12).
 */

const ORG = '11111111-1111-4111-8111-111111111111';
const OUTRA_ORG = '99999999-9999-4999-8999-999999999999';
const PRODUTO = '33333333-3333-4333-8333-333333333333';
const LOCAL = '44444444-4444-4444-8444-444444444444';
/** SAFETY: o escopo é entrada do teste, não o que está sob teste. */
const scope = { organizationId: ORG, actorId: ORG, role: 'owner' } as unknown as VerifiedOrganizationScope;

function blingFalso(opcoes: {
  marcar?: EscritaRemota;
  excluir?: (existe: boolean) => ExclusaoRemota;
  /** O DELETE é aplicado mesmo quando a resposta se perde. */
  efeitoMesmoSemResposta?: boolean;
  consultar?: LeituraRemota<unknown>;
} = {}) {
  const remoto = { existe: true, situacao: 'A' as 'A' | 'E' };
  const chamadas: string[] = [];
  return {
    remoto,
    chamadas,
    porta: {
      async marcarProdutoExcluido(): Promise<EscritaRemota> {
        chamadas.push('situacao-E');
        if (opcoes.marcar) return opcoes.marcar;
        if (!remoto.existe) return { _tag: 'RemotoAusente' };
        remoto.situacao = 'E';
        return { _tag: 'EscritaAceita' };
      },
      async excluirProduto(): Promise<ExclusaoRemota> {
        chamadas.push('delete');
        if (!remoto.existe) return { _tag: 'RemotoAusente' };
        if (remoto.situacao !== 'E') return { _tag: 'RemotoRecusou', status: 400 };
        if (opcoes.excluir) {
          const resultado = opcoes.excluir(remoto.existe);
          if (resultado._tag === 'ExclusaoAceita' || opcoes.efeitoMesmoSemResposta) remoto.existe = false;
          return resultado;
        }
        remoto.existe = false;
        return { _tag: 'ExclusaoAceita' };
      },
      async consultarProduto(): Promise<LeituraRemota<unknown>> {
        chamadas.push('get');
        if (opcoes.consultar) return opcoes.consultar;
        return remoto.existe ? { _tag: 'RemotoPresente', valor: {} } : { _tag: 'RemotoAusente' };
      },
    },
  };
}

let linhas: Array<{ organizacao: string; id: string; blingId: string | null }>;
let bling: ReturnType<typeof blingFalso>;
let diario: string[];
let falharLocal: boolean;

function deps(overrides: Partial<ExclusaoDeProdutoDependencies> = {}): ExclusaoDeProdutoDependencies {
  return {
    autorizar: async () => ({ _tag: 'Autorizado', scope }),
    carregar: async (escopo, id) => linhas.find((l) => l.organizacao === escopo.organizationId && l.id === id) ?? null,
    bling: () => ({
      marcarProdutoExcluido: () => { diario.push('bling:situacao-E'); return bling.porta.marcarProdutoExcluido(); },
      excluirProduto: () => { diario.push('bling:delete'); return bling.porta.excluirProduto(); },
      consultarProduto: () => { diario.push('bling:get'); return bling.porta.consultarProduto(); },
    }),
    excluirLocal: async (escopo, id) => {
      diario.push('local:delete+foto');
      if (falharLocal) throw new Error('23503 violates foreign key constraint "itens_pedido_produto_id_fkey"');
      linhas = linhas.filter((l) => !(l.organizacao === escopo.organizationId && l.id === id));
    },
    ...overrides,
  };
}

async function excluir(corpo: unknown, d = deps()) {
  const resposta = await createExclusaoDeProdutoHandler(d)(new Request('https://orbita.test/api/produtos/delete', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo),
  }));
  return { status: resposta.status, corpo: await resposta.json() as Record<string, unknown> };
}

const existeLocal = (id = PRODUTO) => linhas.some((l) => l.id === id);

beforeEach(() => {
  linhas = [
    { organizacao: ORG, id: PRODUTO, blingId: '16714230397' },
    { organizacao: ORG, id: LOCAL, blingId: null },
    { organizacao: OUTRA_ORG, id: '55555555-5555-4555-8555-555555555555', blingId: '999' },
  ];
  bling = blingFalso();
  diario = [];
  falharLocal = false;
});

describe('exclusão confirmada no Bling', () => {
  it('situação E → DELETE → só então o local (e a foto, depois da linha)', async () => {
    expect(await excluir({ id: PRODUTO })).toEqual({ status: 200, corpo: { success: true, message: 'Produto excluído.', removidoDoBling: true } });
    expect(diario).toEqual(['bling:situacao-E', 'bling:delete', 'local:delete+foto']);
    expect(bling.remoto.existe).toBe(false);
    expect(existeLocal()).toBe(false);
  });

  it('o DELETE direto de produto ativo é recusado pelo Bling — por isso a situação E vem antes', async () => {
    const direto = await bling.porta.excluirProduto();
    expect(direto).toEqual({ _tag: 'RemotoRecusou', status: 400 });
  });

  it('situação E recusada: nada é excluído, nem lá nem aqui, sem DELETE', async () => {
    bling = blingFalso({ marcar: { _tag: 'RemotoRecusou', status: 400 } });
    const r = await excluir({ id: PRODUTO });
    expect(r.status).toBe(409);
    expect(r.corpo.error).toContain('O produto foi mantido no ORBITA.');
    expect(bling.chamadas).toEqual(['situacao-E']);
    expect(existeLocal()).toBe(true);
  });

  it('DELETE ambíguo (rede) + GET 404: exclusão confirmada pela leitura, local sai', async () => {
    bling = blingFalso({ excluir: () => ({ _tag: 'RemotoIndeterminado', causa: 'falha_de_rede' }), efeitoMesmoSemResposta: true });
    expect((await excluir({ id: PRODUTO })).status).toBe(200);
    expect(bling.chamadas).toEqual(['situacao-E', 'delete', 'get']);
    expect(existeLocal()).toBe(false);
  });

  it('DELETE ambíguo + GET produto existente: falha, local preservado, sem segundo DELETE', async () => {
    bling = blingFalso({ excluir: () => ({ _tag: 'RemotoIndeterminado', causa: 'prazo_esgotado' }) });
    const r = await excluir({ id: PRODUTO });
    expect(r.status).toBe(409);
    expect(r.corpo.error).toContain('o produto continua lá');
    expect(bling.chamadas.filter((c) => c === 'delete')).toHaveLength(1);
    expect(existeLocal()).toBe(true);
  });

  it('DELETE ambíguo + leitura também inconclusiva: NÃO apaga localmente', async () => {
    bling = blingFalso({ excluir: () => ({ _tag: 'RemotoIndeterminado', causa: 'erro_do_servidor' }), consultar: { _tag: 'RemotoIndeterminado', causa: 'falha_de_rede' } });
    const r = await excluir({ id: PRODUTO });
    expect(r.status).toBe(503);
    expect(existeLocal()).toBe(true);
  });

  it('limite do Bling: 503, nada excluído', async () => {
    bling = blingFalso({ marcar: { _tag: 'RemotoLimitado' } });
    expect((await excluir({ id: PRODUTO })).status).toBe(503);
    expect(existeLocal()).toBe(true);
  });

  it('situação E sem resposta + leitura confirma ausência: conclui sem DELETE', async () => {
    bling = blingFalso({ marcar: { _tag: 'RemotoIndeterminado', causa: 'falha_de_rede' } });
    bling.remoto.existe = false;
    expect((await excluir({ id: PRODUTO })).status).toBe(200);
    expect(bling.chamadas).toEqual(['situacao-E', 'get']);
    expect(existeLocal()).toBe(false);
  });
});

describe('ORBITA', () => {
  it('produto sem bling_id: só local, sem nenhuma chamada ao Bling', async () => {
    expect(await excluir({ id: LOCAL })).toEqual({ status: 200, corpo: { success: true, message: 'Produto excluído.', removidoDoBling: false } });
    expect(bling.chamadas).toEqual([]);
  });

  it('o bling_id vem do banco: o enviado pelo navegador é ignorado', async () => {
    await excluir({ id: LOCAL, bling_id: '16714230397', organizacao_id: OUTRA_ORG });
    expect(bling.chamadas).toEqual([]);
    expect(bling.remoto.existe).toBe(true);
  });

  it('produto de outra organização ou inexistente: 404, sem chamada ao Bling', async () => {
    expect((await excluir({ id: '55555555-5555-4555-8555-555555555555' })).status).toBe(404);
    expect((await excluir({ id: '66666666-6666-4666-8666-666666666666' })).status).toBe(404);
    expect(bling.chamadas).toEqual([]);
  });

  it('local falha depois do Bling confirmar: 500 sem detalhe do banco; repetir conclui', async () => {
    falharLocal = true;
    const r = await excluir({ id: PRODUTO });
    expect(r.status).toBe(500);
    expect(r.corpo.error).toBe('O produto foi excluído no Bling, mas a exclusão no ORBITA falhou. Tente de novo para concluir.');
    expect(JSON.stringify(r.corpo)).not.toMatch(/23503|constraint|itens_pedido/u);
    expect(existeLocal()).toBe(true);

    falharLocal = false;
    expect((await excluir({ id: PRODUTO })).status).toBe(200);
    expect(existeLocal()).toBe(false);
  });

  it('corpo inválido e sem autorização não chamam nada', async () => {
    expect((await excluir({ id: 'p1' })).status).toBe(400);
    const negado = deps({ autorizar: async () => ({ _tag: 'Negado', response: NextResponse.json({ success: false }, { status: 403 }) }) });
    expect((await excluir({ id: PRODUTO }, negado)).status).toBe(403);
    expect(diario).toEqual([]);
  });
});
