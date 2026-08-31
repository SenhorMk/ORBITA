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

  describe('item fora do contrato não alcança o repositório (ticket 05b)', () => {
    it.each([
      ['sem id', { situacao: 1, valor: 10, vencimento: '2026-09-10' }],
      ['id nulo', { id: null, situacao: 1, valor: 10, vencimento: '2026-09-10' }],
      ['id zero', { id: 0, situacao: 1, valor: 10, vencimento: '2026-09-10' }],
      ['valor nulo', { id: 9001, situacao: 1, valor: null, vencimento: '2026-09-10' }],
      ['valor ausente', { id: 9001, situacao: 1, vencimento: '2026-09-10' }],
      ['vencimento ausente', { id: 9001, situacao: 1, valor: 10 }],
    ])('%s: não grava e conta como inválido', async (_nome, item) => {
      const { deps, upsertTitulo } = montarDeps({
        bling: blingComPaginas({ financeiro_contas_pagar: [[item as RawContaFinanceira]] }),
      });

      const resposta = await createFinanceiroSyncHandler(deps)(requisicao());
      const json = await resposta.json();

      // Sem `id` não há chave de idempotência: gravaria `bling_id: null`, que é
      // justamente a coluna do `ON CONFLICT`. E `valor` ausente virava `0` pelo
      // `Number()`, inventando uma conta de zero real.
      expect(upsertTitulo).not.toHaveBeenCalled();
      expect(json.stats.contasPagar.itensInvalidos).toBe(1);
      expect(json.success).toBe(false);
    });

    it('um item inválido não impede os válidos da mesma página', async () => {
      const { deps, upsertTitulo } = montarDeps({
        bling: blingComPaginas({
          financeiro_contas_pagar: [[CONTA, { situacao: 1, valor: 5 } as RawContaFinanceira, { ...CONTA, id: 9002 }]],
        }),
      });

      const { stats } = await (await createFinanceiroSyncHandler(deps)(requisicao())).json();

      expect(stats.contasPagar.processados).toBe(2);
      expect(stats.contasPagar.itensInvalidos).toBe(1);
      expect(upsertTitulo.mock.calls.map(([, t]) => t.bling_id)).toEqual([9001, 9002]);
    });

    it('id em texto é aceito e normalizado para número', async () => {
      // O OpenAPI diz `integer`, mas JSON de provedor às vezes manda string.
      // Aceitar e normalizar é diferente de aceitar qualquer coisa.
      const { deps, upsertTitulo } = montarDeps({
        bling: blingComPaginas({ financeiro_contas_pagar: [[{ ...CONTA, id: '9001' } as unknown as RawContaFinanceira]] }),
      });

      await createFinanceiroSyncHandler(deps)(requisicao());

      expect(upsertTitulo.mock.calls[0]![1].bling_id).toBe(9001);
    });
  });

  describe('teto de páginas não é fim dos dados (ticket 05b)', () => {
    it('parar no teto com página cheia não marca checkpoint nem diz sucesso', async () => {
      const cheia = Array.from({ length: 100 }, (_, i) => ({ ...CONTA, id: 4000 + i }));
      const { deps: base, marcarCheckpoint } = montarDeps({ bling: { lerPagina: vi.fn().mockResolvedValue(cheia) } });
      const deps: FinanceiroSyncDependencies = { ...base, maxPaginas: 3 };

      const resposta = await createFinanceiroSyncHandler(deps)(requisicao());
      const json = await resposta.json();

      // Havia mais páginas do outro lado: dizer sucesso e marcar conclusão
      // deixaria dados de fora sem ninguém notar.
      expect(json.success).toBe(false);
      expect(json.stats.contasPagar.leituraIncompleta).toBe(true);
      expect(json.error).toContain('limite de páginas');
      expect(marcarCheckpoint).not.toHaveBeenCalled();
    });

    it('parar no teto com a última página parcial é fim de dados legítimo', async () => {
      const cheia = Array.from({ length: 100 }, (_, i) => ({ ...CONTA, id: 5000 + i }));
      const { deps: base, marcarCheckpoint } = montarDeps({
        bling: blingComPaginas({
          financeiro_contas_pagar: [cheia, cheia, [CONTA]],
          financeiro_contas_receber: [[CONTA]],
        }),
      });
      const deps: FinanceiroSyncDependencies = { ...base, maxPaginas: 3 };

      const resposta = await createFinanceiroSyncHandler(deps)(requisicao());

      expect((await resposta.json()).success).toBe(true);
      expect(marcarCheckpoint).toHaveBeenCalledTimes(2);
    });
  });

  describe('o log distingue as causas (ticket 05b)', () => {
    async function logDe(erro: unknown): Promise<string> {
      const linhas: string[] = [];
      const espia = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        linhas.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
      });
      try {
        const { deps } = montarDeps({ bling: { lerPagina: vi.fn().mockRejectedValue(erro) } });
        await createFinanceiroSyncHandler(deps)(requisicao());
      } finally {
        espia.mockRestore();
      }
      return linhas.join('\n');
    }

    it('403 e 500 do provedor deixam de virar a mesma linha', async () => {
      const proibido = Object.assign(new Error('Falha ao ler contas a pagar no Bling (HTTP 403)'), { status: 403 });
      const indisponivel = Object.assign(new Error('Falha ao ler contas a pagar no Bling (HTTP 500)'), { status: 500 });

      const log403 = await logDe(proibido);
      const log500 = await logDe(indisponivel);

      // Antes as duas linhas eram idênticas: só o nome da classe.
      expect(log403).toContain('403');
      expect(log500).toContain('500');
      expect(log403).not.toContain('500');
    });

    it('status implausível é descartado, como o código técnico', async () => {
      const log = await logDe(Object.assign(new Error('falhou'), { status: 'Bearer tok-sintetico' }));

      expect(log).not.toContain('tok-sintetico');
    });
  });

  describe('validação não pode abortar o lote nem inventar valor (revisão do #58)', () => {
    it('item nulo no meio do lote não derruba os válidos', async () => {
      // O ramo de item inválido lia `raw.id` para nomear a linha do log, e
      // `null` é justamente uma das formas rejeitadas: `TypeError`, 500, lote
      // inteiro perdido e o item válido nem tentado.
      const { deps, upsertTitulo } = montarDeps({
        bling: blingComPaginas({
          financeiro_contas_pagar: [[null as unknown as RawContaFinanceira, CONTA]],
        }),
      });

      const resposta = await createFinanceiroSyncHandler(deps)(requisicao());
      const json = await resposta.json();

      expect(resposta.status).toBe(200);
      expect(json.stats.contasPagar.itensInvalidos).toBe(1);
      expect(json.stats.contasPagar.processados).toBe(1);
      expect(upsertTitulo.mock.calls.map(([, t]) => t.bling_id)).toEqual([9001]);
    });

    it.each([
      ['undefined', undefined],
      ['número', 42],
      ['texto', 'nao-e-conta'],
      ['lista', []],
    ])('item %s também é contado e o lote segue', async (_nome, item) => {
      const { deps, upsertTitulo } = montarDeps({
        bling: blingComPaginas({
          financeiro_contas_pagar: [[item as unknown as RawContaFinanceira, CONTA]],
        }),
      });

      const json = await (await createFinanceiroSyncHandler(deps)(requisicao())).json();

      expect(json.stats.contasPagar.itensInvalidos).toBe(1);
      expect(upsertTitulo).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['string vazia', ''],
      ['só espaços', '   '],
      ['hexadecimal', '0xFF'],
      ['notação científica', '1e3'],
      ['texto', 'abc'],
    ])('valor %s é recusado em vez de virar número', async (_nome, valor) => {
      // `Number('')` e `Number('   ')` são 0; `Number('0xFF')` é 255. Gravar
      // isso é inventar um valor que o Bling não mandou.
      const { deps, upsertTitulo } = montarDeps({
        bling: blingComPaginas({
          financeiro_contas_pagar: [[{ ...CONTA, valor } as unknown as RawContaFinanceira]],
        }),
      });

      const json = await (await createFinanceiroSyncHandler(deps)(requisicao())).json();

      expect(upsertTitulo).not.toHaveBeenCalled();
      expect(json.stats.contasPagar.itensInvalidos).toBe(1);
    });

    it.each([
      ['zero numérico', 0, 0],
      ['zero em texto', '0', 0],
      ['decimal em texto', '250.50', 250.5],
      ['negativo em texto', '-30', -30],
    ])('valor %s é legítimo e passa', async (_nome, valor, esperado) => {
      // O outro lado da guarda: apertar demais recusaria conta de valor zero,
      // que existe.
      const { deps, upsertTitulo } = montarDeps({
        bling: blingComPaginas({
          financeiro_contas_pagar: [[{ ...CONTA, valor } as unknown as RawContaFinanceira]],
        }),
      });

      await createFinanceiroSyncHandler(deps)(requisicao());

      expect(upsertTitulo.mock.calls[0]![1].valor).toBe(esperado);
    });

    it('o aviso do teto de páginas não promete progresso por repetição', async () => {
      // Cada execução começa na página 1: repetir lê as mesmas páginas e deixa
      // as mesmas contas de fora.
      const cheia = Array.from({ length: 100 }, (_, i) => ({ ...CONTA, id: 8000 + i }));
      const { deps: base } = montarDeps({ bling: { lerPagina: vi.fn().mockResolvedValue(cheia) } });
      const deps: FinanceiroSyncDependencies = { ...base, maxPaginas: 2 };

      const { error } = await (await createFinanceiroSyncHandler(deps)(requisicao())).json();

      expect(error).toContain('limite de páginas');
      expect(error).not.toMatch(/rode novamente/iu);
      expect(error).toMatch(/ampliar o limite|filtrar por período/iu);
    });
  });
});
