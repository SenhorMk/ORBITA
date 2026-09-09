import { describe, expect, it, vi } from 'vitest';

import { createFinanceiroSyncHandler } from '@/app/api/financeiro/sync/handler';
import type {
  EntidadeFinanceira,
  FinanceiroSyncBlingPort,
  FinanceiroSyncDependencies,
  FinanceiroSyncStorePort,
  RawContaFinanceira,
} from '@/app/api/financeiro/sync/ports';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';

import { executarSyncFinanceiro } from './financeiroSync';

/**
 * A ligação entre a resposta da rota e o que a tela mostra.
 *
 * As duas pontas tinham teste e mesmo assim divergiam: a rota passou a reportar
 * falha e parcialidade no ticket 05, e a tela continuou tratando tudo como
 * sucesso — `fetchWithAuth` devolve a `Response` sem lançar em não-2xx, então
 * 502 e `200 { success: false }` seguiam o caminho do sucesso e o lojista via
 * dado velho como se estivesse sincronizado.
 *
 * Por isso este teste **não** remonta o corpo da resposta: ele roda o handler
 * de verdade, pega a `Response` que ele produziu e entrega essa mesma
 * `Response` ao consumidor da tela. Se um dos dois lados mudar de forma sem o
 * outro, o caso fica vermelho.
 */

const ORG = '11111111-1111-4111-8111-111111111111';
const escopo = {
  organizationId: ORG,
  actorId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
  role: 'owner',
} as unknown as VerifiedOrganizationScope;

const CONTA: RawContaFinanceira = { id: 9001, situacao: 1, valor: 250.5, vencimento: '2026-09-10' };

function deps(overrides: {
  bling?: FinanceiroSyncBlingPort;
  store?: Partial<FinanceiroSyncStorePort>;
  maxPaginas?: number;
}): FinanceiroSyncDependencies {
  return {
    auth: {
      authenticate: async () => ({ actorId: escopo.actorId }),
      resolveScope: async () => ({ _tag: 'Resolved' as const, scope: escopo }),
    },
    store: {
      upsertTitulo: vi.fn().mockResolvedValue(undefined),
      vincularPedidos: vi.fn().mockResolvedValue(new Map()),
      marcarCheckpoint: vi.fn().mockResolvedValue(undefined),
      ...overrides.store,
    },
    bling: overrides.bling ?? { lerPagina: vi.fn().mockResolvedValue([]) },
    maxPaginas: overrides.maxPaginas,
  };
}

/** Roda a rota de verdade e entrega a resposta dela ao consumidor da tela. */
async function avisoNaTela(dependencias: FinanceiroSyncDependencies): Promise<string> {
  const resposta = await createFinanceiroSyncHandler(dependencias)(
    new Request('https://orbita.test/api/financeiro/sync', { method: 'POST' }),
  );
  // O que está sob prova é a fronteira handler↔consumidor: a `Response` é a
  // que o handler produziu de fato, e o transporte devolve ela sem lançar em
  // não-2xx, como `fetchWithAuth` faz. Auth, store e Bling também são dublês —
  // não é a pilha inteira que está sendo exercitada, é o contrato entre os
  // dois lados que divergiram.
  return executarSyncFinanceiro(async () => resposta);
}

function paginasCheias(quantidade: number): RawContaFinanceira[] {
  return Array.from({ length: quantidade }, (_, i) => ({ ...CONTA, id: 7000 + i }));
}

describe('a resposta da rota chega à tela', () => {
  it('sucesso não mostra aviso nenhum', async () => {
    expect(await avisoNaTela(deps({}))).toBe('');
  });

  it('leitura que falha (502) vira aviso na tela', async () => {
    const aviso = await avisoNaTela(deps({
      bling: { lerPagina: vi.fn().mockRejectedValue(new Error('HTTP 401')) },
    }));

    // Antes: 502 seguia o caminho do sucesso e a tela recarregava calada.
    expect(aviso).not.toBe('');
    expect(aviso).toContain('Bling');
  });

  it('parcialidade (200 com success:false) também vira aviso', async () => {
    const upsertTitulo = vi.fn().mockRejectedValue(new Error('valor inválido'));
    const aviso = await avisoNaTela(deps({
      store: { upsertTitulo },
      bling: { lerPagina: vi.fn(async (_e: EntidadeFinanceira, p: number) => (p === 1 ? [CONTA] : [])) },
    }));

    // HTTP 200 e mesmo assim falhou: é exatamente o caso que `resposta.ok`
    // sozinho não pega, e por isso o consumidor olha `success` também.
    expect(aviso).toContain('não puderam ser gravados');
  });

  it('leitura incompleta pelo teto de páginas vira aviso', async () => {
    const aviso = await avisoNaTela(deps({
      bling: { lerPagina: vi.fn().mockResolvedValue(paginasCheias(100)) },
      maxPaginas: 2,
    }));

    expect(aviso).toContain('limite de páginas');
  });

  it('item fora do contrato vira aviso, mesmo com a leitura inteira ok', async () => {
    const aviso = await avisoNaTela(deps({
      bling: {
        lerPagina: vi.fn(async (_e: EntidadeFinanceira, p: number) =>
          (p === 1 ? [{ situacao: 1, valor: 10, vencimento: '2026-09-10' } as RawContaFinanceira] : [])),
      },
    }));

    expect(aviso).toContain('não puderam ser gravados');
  });

  it('o aviso nunca carrega diagnóstico interno', async () => {
    // A mensagem vem pronta do servidor, que a monta genérica (CWE-209). Se
    // alguém voltar a repassar o erro do provedor, este caso pega.
    const erroDetalhado = Object.assign(
      new Error('permission denied for table titulos_financeiros — Key (email)=(sintetico@exemplo.com)'),
      { status: 403 },
    );
    const aviso = await avisoNaTela(deps({ bling: { lerPagina: vi.fn().mockRejectedValue(erroDetalhado) } }));

    expect(aviso).not.toContain('permission denied');
    expect(aviso).not.toContain('sintetico@exemplo.com');
    expect(aviso).not.toContain('titulos_financeiros');
  });

  it('corpo ilegível não deixa a tela sem aviso', async () => {
    // Um proxy que devolve HTML no lugar do JSON não pode virar "deu certo".
    const aviso = await executarSyncFinanceiro(async () =>
      new Response('<html>Bad Gateway</html>', { status: 502 }));

    expect(aviso).toBe('Não foi possível concluir a sincronização.');
  });

  describe('HTTP 200 com corpo inválido não é conclusão (revisão do #58)', () => {
    it.each([
      ['objeto vazio', '{}', 'application/json'],
      ['nulo', 'null', 'application/json'],
      ['lista', '[]', 'application/json'],
      ['HTML de proxy', '<html>OK</html>', 'text/html'],
      ['texto solto', 'ok', 'text/plain'],
    ])('%s com HTTP 200 gera aviso genérico', async (_nome, corpo, tipo) => {
      // Antes bastava não existir `success: false` para a tela ficar calada:
      // qualquer 200 sem envelope passava por conclusão.
      const aviso = await executarSyncFinanceiro(async () =>
        new Response(corpo, { status: 200, headers: { 'content-type': tipo } }));

      expect(aviso).toBe('Não foi possível concluir a sincronização.');
    });

    it('sucesso precisa ser afirmado, não apenas não-negado', async () => {
      const semAfirmacao = await executarSyncFinanceiro(async () =>
        new Response(JSON.stringify({ stats: {} }), { status: 200 }));
      const afirmado = await executarSyncFinanceiro(async () =>
        new Response(JSON.stringify({ success: true, stats: {} }), { status: 200 }));

      expect(semAfirmacao).not.toBe('');
      expect(afirmado).toBe('');
    });

    it('`error` que não é texto não vai para a tela', async () => {
      // Exibir sem conferir o tipo colocaria `[object Object]` na tela — a
      // mesma família de defeito do ticket 03.
      const aviso = await executarSyncFinanceiro(async () =>
        new Response(JSON.stringify({ success: false, error: { codigo: 42 } }), { status: 200 }));

      expect(aviso).toBe('Não foi possível concluir a sincronização.');
      expect(aviso).not.toContain('[object Object]');
    });

    it('`error` vazio ou só espaços cai na mensagem genérica', async () => {
      const vazio = await executarSyncFinanceiro(async () =>
        new Response(JSON.stringify({ success: false, error: '   ' }), { status: 200 }));

      expect(vazio).toBe('Não foi possível concluir a sincronização.');
    });
  });
});
