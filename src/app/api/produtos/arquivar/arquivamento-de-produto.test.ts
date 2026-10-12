import { NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { EscritaRemota, LeituraRemota, ProdutoRemoto } from '@/lib/integrations/bling/operacaoRemotaContract';
import { logger } from '@/lib/observability/logger';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';

import { createArquivamentoDeProdutoHandler, type ArquivamentoDeProdutoDependencies } from './handler';

/**
 * Arquivar produto (PRE-003): Bling inativo com prova, depois o arquivamento
 * local — que nunca apaga o produto, a foto nem os pedidos. A semântica do
 * `arquivar_produto` (idempotente, por organização) é a da migration 75,
 * provada contra Postgres real no pgTAP e na corrida.
 */

const ORG = '11111111-1111-4111-8111-111111111111';
const OUTRA_ORG = '99999999-9999-4999-8999-999999999999';
const PRODUTO = '33333333-3333-4333-8333-333333333333';
const LOCAL = '44444444-4444-4444-8444-444444444444';
const DE_B = '55555555-5555-4555-8555-555555555555';
/** SAFETY: o escopo é entrada do teste, não o que está sob teste. */
const scope = { organizationId: ORG, actorId: ORG, role: 'owner' } as unknown as VerifiedOrganizationScope;

type Situacao = 'ativo' | 'inativo' | 'arquivado';
interface Linha { organizacao: string; id: string; blingId: string | null; situacao: Situacao; estoqueReservado: number; itensDePedido: number }

let linhas: Linha[];
let remoto: { situacao: 'A' | 'I' };
let diario: string[];
let respostaDaEscrita: EscritaRemota | null;
let respostaDaLeitura: LeituraRemota<Pick<ProdutoRemoto, 'situacao'>> | null;
let falharLocal: boolean;

function deps(overrides: Partial<ArquivamentoDeProdutoDependencies> = {}): ArquivamentoDeProdutoDependencies {
  return {
    autorizar: async () => ({ _tag: 'Autorizado', scope }),
    carregar: async (escopo, id) => {
      const l = linhas.find((x) => x.organizacao === escopo.organizationId && x.id === id);
      return l ? { id: l.id, blingId: l.blingId, situacao: l.situacao } : null;
    },
    bling: () => ({
      async marcarProdutoInativo() {
        diario.push('bling:situacao-I');
        // O efeito acontece mesmo quando a resposta se perde.
        remoto.situacao = 'I';
        return respostaDaEscrita ?? { _tag: 'EscritaAceita' };
      },
      async consultarProduto() {
        diario.push('bling:get');
        return respostaDaLeitura ?? { _tag: 'RemotoPresente', valor: { situacao: remoto.situacao } };
      },
    }),
    arquivarLocal: async (escopo, id) => {
      diario.push('local:arquivar');
      if (falharLocal) throw new Error('42501 permission denied for table produtos');
      const l = linhas.find((x) => x.organizacao === escopo.organizationId && x.id === id);
      if (!l) return 'nao_encontrado';
      if (l.situacao === 'arquivado') return 'ja_arquivado';
      l.situacao = 'arquivado';
      return 'arquivado';
    },
    correlationId: () => 'corr-teste',
    ...overrides,
  };
}

async function arquivar(corpo: unknown, d = deps()) {
  const resposta = await createArquivamentoDeProdutoHandler(d)(new Request('https://orbita.test/api/produtos/arquivar', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo),
  }));
  return { status: resposta.status, corpo: await resposta.json() as Record<string, unknown> };
}

const linha = (id = PRODUTO) => linhas.find((l) => l.id === id);

beforeEach(() => {
  linhas = [
    { organizacao: ORG, id: PRODUTO, blingId: '16714230397', situacao: 'ativo', estoqueReservado: 2, itensDePedido: 3 },
    { organizacao: ORG, id: LOCAL, blingId: null, situacao: 'ativo', estoqueReservado: 0, itensDePedido: 0 },
    { organizacao: OUTRA_ORG, id: DE_B, blingId: '999', situacao: 'ativo', estoqueReservado: 0, itensDePedido: 0 },
  ];
  remoto = { situacao: 'A' };
  diario = [];
  respostaDaEscrita = null;
  respostaDaLeitura = null;
  falharLocal = false;
});

describe('arquivar com o Bling confirmando', () => {
  it('situação I no Bling → só então o arquivamento local; nada é apagado', async () => {
    expect(await arquivar({ id: PRODUTO })).toEqual({
      status: 200, corpo: { success: true, message: 'Produto arquivado.', arquivado: true, foraDaVendaNoBling: 'I' },
    });
    expect(diario).toEqual(['bling:situacao-I', 'local:arquivar']);
    expect(linha()).toMatchObject({ situacao: 'arquivado', estoqueReservado: 2, itensDePedido: 3 });
  });

  it('nunca pede E nem DELETE ao Bling: a porta só tem inativar e ler', () => {
    const porta = deps().bling(scope);
    expect(Object.keys(porta).sort()).toEqual(['consultarProduto', 'marcarProdutoInativo']);
  });

  it('repetir é idempotente: o segundo pedido não chama o Bling e responde sucesso', async () => {
    await arquivar({ id: PRODUTO });
    diario = [];
    expect(await arquivar({ id: PRODUTO })).toMatchObject({ status: 200, corpo: { success: true, arquivado: true } });
    expect(diario).toEqual([]);
  });

  it('duas ações concorrentes: as duas terminam bem, o produto termina arquivado uma vez', async () => {
    const [a, b] = await Promise.all([arquivar({ id: PRODUTO }), arquivar({ id: PRODUTO })]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(linha()).toMatchObject({ situacao: 'arquivado', itensDePedido: 3 });
    expect(diario.filter((e) => e === 'local:arquivar')).toHaveLength(2);
    expect(linhas).toHaveLength(3);
  });

  it('ACK perdido na escrita + leitura mostra inativo: conclui sem segunda escrita', async () => {
    respostaDaEscrita = { _tag: 'RemotoIndeterminado', causa: 'falha_de_rede' };
    expect((await arquivar({ id: PRODUTO })).status).toBe(200);
    expect(diario).toEqual(['bling:situacao-I', 'bling:get', 'local:arquivar']);
  });
});

describe('sem prova no Bling, nada local muda', () => {
  it.each([
    ['recusa do Bling', { _tag: 'RemotoRecusou', status: 400 } as const, null, 409],
    ['limite do Bling', { _tag: 'RemotoLimitado' } as const, null, 503],
    ['ACK perdido e o produto ainda ativo lá', { _tag: 'RemotoIndeterminado', causa: 'prazo_esgotado' } as const,
      { _tag: 'RemotoPresente', valor: { situacao: 'A' } } as const, 409],
    ['ACK perdido e a leitura também sem resposta', { _tag: 'RemotoIndeterminado', causa: 'erro_do_servidor' } as const,
      { _tag: 'RemotoIndeterminado', causa: 'falha_de_rede' } as const, 503],
  ])('%s: %#', async (_caso, escrita, leitura, status) => {
    respostaDaEscrita = escrita;
    respostaDaLeitura = leitura;
    const r = await arquivar({ id: PRODUTO });
    expect(r.status).toBe(status);
    expect(r.corpo.success).toBe(false);
    expect(String(r.corpo.error)).toContain('O produto continua ativo no ORBITA.');
    expect(diario).not.toContain('local:arquivar');
    expect(linha()?.situacao).toBe('ativo');
  });
});

describe('ORBITA', () => {
  it('produto sem bling_id: só o arquivamento local, sem nenhuma chamada ao Bling', async () => {
    expect(await arquivar({ id: LOCAL })).toMatchObject({ status: 200, corpo: { success: true, foraDaVendaNoBling: null } });
    expect(diario).toEqual(['local:arquivar']);
  });

  it('o bling_id e a organização vêm do banco: os do corpo são ignorados', async () => {
    await arquivar({ id: LOCAL, bling_id: '16714230397', organizacao_id: OUTRA_ORG });
    expect(diario).toEqual(['local:arquivar']);
    expect(remoto.situacao).toBe('A');
  });

  it('produto de outra organização ou inexistente: 404, sem chamada ao Bling nem efeito', async () => {
    expect((await arquivar({ id: DE_B })).status).toBe(404);
    expect((await arquivar({ id: '66666666-6666-4666-8666-666666666666' })).status).toBe(404);
    expect(diario).toEqual([]);
    expect(linha(DE_B)?.situacao).toBe('ativo');
  });

  it('local falha depois do Bling confirmar: 500 sem detalhe do banco; repetir conclui', async () => {
    falharLocal = true;
    const r = await arquivar({ id: PRODUTO });
    expect(r.status).toBe(500);
    expect(r.corpo.error).toBe('O produto saiu da venda no Bling, mas o arquivamento no ORBITA falhou. Tente de novo para concluir.');
    expect(JSON.stringify(r.corpo)).not.toMatch(/42501|permission|produtos/u);
    expect(linha()?.situacao).toBe('ativo');

    falharLocal = false;
    expect((await arquivar({ id: PRODUTO })).status).toBe(200);
    expect(linha()?.situacao).toBe('arquivado');
  });

  it('corpo inválido e sem autorização não chamam nada', async () => {
    expect((await arquivar({ id: 'p1' })).status).toBe(400);
    expect((await arquivar({})).status).toBe(400);
    const negado = deps({ autorizar: async () => ({ _tag: 'Negado', response: NextResponse.json({ success: false }, { status: 403 }) }) });
    expect((await arquivar({ id: PRODUTO }, negado)).status).toBe(403);
    expect(diario).toEqual([]);
    expect(linha()?.situacao).toBe('ativo');
  });
});

describe('observabilidade', () => {
  it('o evento de recusa tem correlação, organização e produto, e nada do corpo do Bling', async () => {
    const aviso = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    respostaDaEscrita = { _tag: 'RemotoRecusou', status: 400 };
    await arquivar({ id: PRODUTO });
    expect(aviso).toHaveBeenCalledWith('produtos.arquivamento.recusado', expect.objectContaining({
      correlationId: 'corr-teste', organizacaoId: ORG, produto: PRODUTO, desfecho: 'Recusada',
    }));
    aviso.mockRestore();
  });
});
