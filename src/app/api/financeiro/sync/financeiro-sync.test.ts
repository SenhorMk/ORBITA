import { NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import type { TituloFinanceiro } from '@/types';

import { createFinanceiroSyncHandler } from './handler';
import type {
  EntidadeFinanceira,
  FinanceiroSyncAuthPort,
  FinanceiroSyncBlingPort,
  FinanceiroSyncDependencies,
  FinanceiroSyncStorePort,
  RawContaFinanceira,
} from './ports';

/**
 * Testes da sincronização financeira.
 *
 * Era o maior arquivo sem teste do caminho do Bling, e repetia inteiras as
 * cinco camadas que transformaram a sincronização de catálogo em "0 produtos"
 * com 17 no Bling: leitura devolvendo `[]` em erro, checkpoint avançando com
 * zero itens, etapa devolvendo zero numa falha, rota concluindo com sucesso, e
 * falha de item virando `console.warn`.
 */

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const ATOR = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

const escopo = { organizationId: ORG_A, actorId: ATOR, role: 'owner' } as unknown as VerifiedOrganizationScope;

const CONTA: RawContaFinanceira = {
  id: 9001,
  situacao: 1,
  valor: 250.5,
  vencimento: '2026-09-10',
  historico: 'Aluguel',
};

function requisicao(): Request {
  return new Request('https://orbita.test/api/financeiro/sync', { method: 'POST' });
}

/** Páginas por entidade; o que não estiver aqui responde vazio. */
function blingComPaginas(paginas: Partial<Record<EntidadeFinanceira, RawContaFinanceira[][]>>): FinanceiroSyncBlingPort {
  return {
    lerPagina: vi.fn(async (entidade: EntidadeFinanceira, pagina: number) => {
      return paginas[entidade]?.[pagina - 1] ?? [];
    }),
  };
}

function montarDeps(sobrescritas: {
  store?: Partial<FinanceiroSyncStorePort>;
  bling?: FinanceiroSyncBlingPort;
  auth?: Partial<FinanceiroSyncAuthPort>;
} = {}) {
  const upsertTitulo = vi.fn<FinanceiroSyncStorePort['upsertTitulo']>().mockResolvedValue(undefined);
  const marcarCheckpoint = vi.fn<FinanceiroSyncStorePort['marcarCheckpoint']>().mockResolvedValue(undefined);

  const store: FinanceiroSyncStorePort = { upsertTitulo, marcarCheckpoint, ...sobrescritas.store };
  const bling: FinanceiroSyncBlingPort = sobrescritas.bling ?? blingComPaginas({});
  const auth: FinanceiroSyncAuthPort = {
    authenticate: vi.fn().mockResolvedValue({ actorId: ATOR }),
    resolveScope: vi.fn().mockResolvedValue({ _tag: 'Resolved', scope: escopo }),
    ...sobrescritas.auth,
  };

  const deps: FinanceiroSyncDependencies = { auth, store, bling };
  return { deps, store, bling, upsertTitulo, marcarCheckpoint };
}

describe('POST /api/financeiro/sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('falha de leitura não conclui a etapa como sucesso', () => {
    it('leitura que estoura devolve 502, e não sucesso com zero processados', async () => {
      // Este é o defeito original: `getContasPagar` devolvia `[]` em 401, 403,
      // 500 e timeout. O laço lia lista vazia, entendia "acabaram os dados", e
      // a etapa terminava com `processados: 0` e `success: true`.
      const bling: FinanceiroSyncBlingPort = {
        lerPagina: vi.fn().mockRejectedValue(new Error('Falha ao ler contas a pagar no Bling (HTTP 401): token expirado')),
      };
      const { deps, marcarCheckpoint } = montarDeps({ bling });

      const resposta = await createFinanceiroSyncHandler(deps)(requisicao());

      expect(resposta.status).toBe(502);
      const json = await resposta.json();
      expect(json.success).toBe(false);
      expect(json.stats.contasPagar.leituraFalhou).toBe(true);

      // E o checkpoint não avança: marcar aqui registraria um progresso que
      // não houve, e foi o checkpoint envenenado que tornou a falha permanente
      // na sincronização de catálogo.
      expect(marcarCheckpoint).not.toHaveBeenCalled();
    });

    it('falha na segunda página preserva o que já foi gravado e ainda assim não conclui', async () => {
      const bling: FinanceiroSyncBlingPort = {
        // Só contas a pagar tem dados; a falha é na página 2 dela. Contas a
        // receber fica vazia, para a contagem abaixo isolar uma entidade.
        lerPagina: vi.fn(async (entidade: EntidadeFinanceira, pagina: number) => {
          if (entidade !== 'financeiro_contas_pagar') return [];
          if (pagina === 1) return Array.from({ length: 100 }, (_, i) => ({ ...CONTA, id: 1000 + i }));
          throw new Error('fetch failed');
        }),
      };
      const { deps, upsertTitulo, marcarCheckpoint } = montarDeps({ bling });

      const resposta = await createFinanceiroSyncHandler(deps)(requisicao());

      expect(resposta.status).toBe(502);
      const json = await resposta.json();
      // O trabalho da página 1 não é jogado fora nem escondido.
      expect(json.stats.contasPagar.processados).toBe(100);
      expect(upsertTitulo).toHaveBeenCalledTimes(100);

      // O checkpoint é por entidade: contas a pagar falhou e não avança;
      // contas a receber leu até o fim e avança normalmente. A falha de uma
      // direção não pode congelar a outra, nem mentir sobre a própria.
      const entidadesMarcadas = marcarCheckpoint.mock.calls.map(([, entidade]) => entidade);
      expect(entidadesMarcadas).toEqual(['financeiro_contas_receber']);
    });

    it('lista vazia é fim dos dados, não falha — e aí o checkpoint avança', async () => {
      const { deps, marcarCheckpoint } = montarDeps();

      const resposta = await createFinanceiroSyncHandler(deps)(requisicao());

      expect(resposta.status).toBe(200);
      expect((await resposta.json()).success).toBe(true);
      expect(marcarCheckpoint).toHaveBeenCalledTimes(2);
    });

    it('falha ao gravar um item não derruba o lote, mas aparece na resposta', async () => {
      // Antes isto era só um `console.warn`: o item sumia e a rota respondia
      // sucesso limpo.
      const upsertTitulo = vi.fn(async (_escopo: VerifiedOrganizationScope, titulo: TituloFinanceiro) => {
        if (titulo.bling_id === 9002) throw new Error('valor inválido');
      });
      const { deps } = montarDeps({
        store: { upsertTitulo },
        bling: blingComPaginas({
          financeiro_contas_pagar: [[CONTA, { ...CONTA, id: 9002 }, { ...CONTA, id: 9003 }]],
        }),
      });

      const resposta = await createFinanceiroSyncHandler(deps)(requisicao());

      expect(resposta.status).toBe(200);
      const json = await resposta.json();
      expect(json.success).toBe(false);
      expect(json.error).toContain('1 título(s)');
      expect(json.stats.contasPagar.processados).toBe(2);
      expect(json.stats.contasPagar.falhasPermanentes).toBe(1);
    });

    it('distingue falha temporária de permanente', async () => {
      const upsertTitulo = vi.fn(async (_e: VerifiedOrganizationScope, titulo: TituloFinanceiro) => {
        if (titulo.bling_id === 9002) throw new Error('ETIMEDOUT ao gravar');
        if (titulo.bling_id === 9003) throw new Error('valor inválido');
      });
      const { deps } = montarDeps({
        store: { upsertTitulo },
        bling: blingComPaginas({
          financeiro_contas_pagar: [[CONTA, { ...CONTA, id: 9002 }, { ...CONTA, id: 9003 }]],
        }),
      });

      const { stats } = await (await createFinanceiroSyncHandler(deps)(requisicao())).json();

      // A distinção decide se reprocessar adianta.
      expect(stats.contasPagar.falhasTemporarias).toBe(1);
      expect(stats.contasPagar.falhasPermanentes).toBe(1);
    });
  });

  describe('reexecução atualiza em vez de duplicar', () => {
    it('a mesma conta lida duas vezes grava com o mesmo bling_id', async () => {
      const { deps, upsertTitulo } = montarDeps({
        bling: blingComPaginas({ financeiro_contas_pagar: [[CONTA]] }),
      });
      const handler = createFinanceiroSyncHandler(deps);

      await handler(requisicao());
      await handler(requisicao());

      // A idempotência vive no `onConflict (organizacao_id, bling_id)` do
      // repositório; o que o handler garante é a chave estável — mesmo item,
      // mesmo `bling_id`, nas duas execuções.
      const chaves = upsertTitulo.mock.calls.map(([, titulo]) => titulo.bling_id);
      expect(chaves).toEqual([9001, 9001]);
      expect(upsertTitulo).toHaveBeenCalledTimes(2);
    });

    it('situação e pagamento são remapeados a cada execução, não acumulados', async () => {
      const { deps, upsertTitulo } = montarDeps({
        bling: blingComPaginas({
          financeiro_contas_pagar: [[{ ...CONTA, situacao: 2, pagamento: { data: '2026-09-01' } }]],
        }),
      });

      await createFinanceiroSyncHandler(deps)(requisicao());

      const [, titulo] = upsertTitulo.mock.calls[0]!;
      expect(titulo.situacao).toBe('pago');
      expect(titulo.data_pagamento).toBe('2026-09-01');
      expect(titulo.tipo).toBe('pagar');
    });

    it('contas a receber são gravadas como receber, não como pagar', async () => {
      const { deps, upsertTitulo } = montarDeps({
        bling: blingComPaginas({ financeiro_contas_receber: [[CONTA]] }),
      });

      await createFinanceiroSyncHandler(deps)(requisicao());

      const tipos = upsertTitulo.mock.calls.map(([, titulo]) => titulo.tipo);
      expect(tipos).toEqual(['receber']);
    });
  });

  describe('isolamento organizacional', () => {
    it('toda gravação e todo checkpoint usam o escopo verificado', async () => {
      const { deps, upsertTitulo, marcarCheckpoint } = montarDeps({
        bling: blingComPaginas({ financeiro_contas_pagar: [[CONTA]], financeiro_contas_receber: [[CONTA]] }),
      });

      await createFinanceiroSyncHandler(deps)(requisicao());

      for (const [escopoUsado] of upsertTitulo.mock.calls) {
        expect(escopoUsado.organizationId).toBe(ORG_A);
      }
      for (const [escopoUsado] of marcarCheckpoint.mock.calls) {
        expect(escopoUsado.organizationId).toBe(ORG_A);
      }
      // Nenhuma chamada carrega a outra organização.
      const organizacoes = new Set(upsertTitulo.mock.calls.map(([e]) => e.organizationId));
      expect(organizacoes).toEqual(new Set([ORG_A]));
      expect(organizacoes.has(ORG_B)).toBe(false);
    });

    it('o escopo vem do limite de autorização, nunca do corpo da requisição', async () => {
      const { deps, upsertTitulo } = montarDeps({
        auth: {
          resolveScope: vi.fn().mockResolvedValue({
            _tag: 'Resolved',
            scope: { organizationId: ORG_B, actorId: ATOR, role: 'owner' } as unknown as VerifiedOrganizationScope,
          }),
        },
        bling: blingComPaginas({ financeiro_contas_pagar: [[CONTA]] }),
      });

      await createFinanceiroSyncHandler(deps)(requisicao());

      expect(upsertTitulo.mock.calls[0]![0].organizationId).toBe(ORG_B);
    });
  });

  describe('autorização', () => {
    it('sem sessão, 401 antes de qualquer leitura', async () => {
      const bling = blingComPaginas({ financeiro_contas_pagar: [[CONTA]] });
      const { deps } = montarDeps({ auth: { authenticate: vi.fn().mockResolvedValue(null) }, bling });

      const resposta = await createFinanceiroSyncHandler(deps)(requisicao());

      expect(resposta.status).toBe(401);
      expect(bling.lerPagina).not.toHaveBeenCalled();
    });

    it('escopo recusado devolve a resposta do próprio limite de autorização', async () => {
      const bling = blingComPaginas({ financeiro_contas_pagar: [[CONTA]] });
      const { deps } = montarDeps({
        auth: {
          resolveScope: vi.fn().mockResolvedValue({
            _tag: 'Denied',
            response: NextResponse.json({ success: false, error: 'Organização não informada' }, { status: 403 }),
          }),
        },
        bling,
      });

      const resposta = await createFinanceiroSyncHandler(deps)(requisicao());

      expect(resposta.status).toBe(403);
      expect(bling.lerPagina).not.toHaveBeenCalled();
    });
  });

  describe('paginação', () => {
    it('página cheia pede a próxima; página parcial encerra', async () => {
      const cheia = Array.from({ length: 100 }, (_, i) => ({ ...CONTA, id: 2000 + i }));
      const { deps, bling } = montarDeps({
        bling: blingComPaginas({ financeiro_contas_pagar: [cheia, [CONTA]] }),
      });

      await createFinanceiroSyncHandler(deps)(requisicao());

      const paginasPagar = (bling.lerPagina as ReturnType<typeof vi.fn>).mock.calls
        .filter(([entidade]) => entidade === 'financeiro_contas_pagar')
        .map(([, pagina]) => pagina);
      expect(paginasPagar).toEqual([1, 2]);
    });

    it('respeita o teto de páginas em vez de girar sem fim', async () => {
      const cheia = Array.from({ length: 100 }, (_, i) => ({ ...CONTA, id: 3000 + i }));
      const { deps: base } = montarDeps({
        bling: { lerPagina: vi.fn().mockResolvedValue(cheia) },
      });
      const deps: FinanceiroSyncDependencies = { ...base, maxPaginas: 3 };

      await createFinanceiroSyncHandler(deps)(requisicao());

      const chamadasPagar = (deps.bling.lerPagina as ReturnType<typeof vi.fn>).mock.calls
        .filter(([entidade]) => entidade === 'financeiro_contas_pagar');
      expect(chamadasPagar).toHaveLength(3);
    });
  });

  describe('erro inesperado não expõe diagnóstico interno (CWE-209)', () => {
    it('resposta 500 é exatamente a frase genérica', async () => {
      const { deps } = montarDeps({
        auth: {
          resolveScope: vi.fn().mockRejectedValue({
            code: '42501',
            message: 'permission denied for table titulos_financeiros',
            details: 'Key (email)=(cliente-sintetico@exemplo.com) already exists.',
          }),
        },
      });

      const resposta = await createFinanceiroSyncHandler(deps)(requisicao());

      expect(resposta.status).toBe(500);
      expect(await resposta.json()).toEqual({ success: false, error: 'Erro interno' });
    });
  });
});
