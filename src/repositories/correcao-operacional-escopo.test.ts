import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { VerifiedOrganizationScope } from '../lib/verifiedOrganizationScope';

/**
 * As consultas da correção operacional contra um Supabase que **grava** o que
 * recebe. O cliente é `service_role` e ignora RLS: quem impede o cruzamento de
 * organização é o filtro que o repositório aplica — então é ele que se confere,
 * consulta por consulta.
 */

interface Consulta {
  readonly tabela: string;
  readonly chamadas: Array<[string, ...unknown[]]>;
}

const consultas: Consulta[] = [];
let respostas: Array<{ data?: unknown; error?: unknown; count?: number | null }> = [];
/**
 * Linhas em memória por tabela. Quando uma tabela tem linhas aqui, a consulta
 * a ela **aplica de verdade** os filtros `eq`/`is`/`in` gravados — o teste
 * então prova o que a consulta encontra, e não só que ela tem um filtro.
 */
let tabelas: Record<string, Array<Record<string, unknown>>> = {};

function avaliar(consulta: Consulta) {
  const linhas = (tabelas[consulta.tabela] ?? []).filter((linha) =>
    consulta.chamadas.every(([metodo, coluna, valor]) => {
      if (metodo === 'eq') return linha[coluna as string] === valor;
      if (metodo === 'is') return (linha[coluna as string] ?? null) === valor;
      if (metodo === 'in') return (valor as unknown[]).includes(linha[coluna as string]);
      return true;
    }));
  return { data: linhas, count: linhas.length, error: null };
}

function construtor(tabela: string) {
  const consulta: Consulta = { tabela, chamadas: [] };
  consultas.push(consulta);
  const resposta = () => (tabela in tabelas
    ? avaliar(consulta)
    : respostas.shift() ?? { data: null, error: null, count: 0 });
  const alvo: Record<string, unknown> = {
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(resposta()).then(resolve, reject),
  };
  return new Proxy(alvo, {
    get(obj, prop: string) {
      if (prop in obj) return obj[prop];
      if (prop === 'maybeSingle' || prop === 'single') {
        return () => { consulta.chamadas.push([prop]); return Promise.resolve(resposta()); };
      }
      return (...args: unknown[]) => { consulta.chamadas.push([prop, ...args]); return new Proxy(alvo, this); };
    },
  });
}

const rpc = vi.fn();

vi.mock('../lib/supabaseServer', () => ({
  supabaseServer: { from: (tabela: string) => construtor(tabela), rpc: (...args: unknown[]) => rpc(...args) },
}));

const ORG = '11111111-1111-4111-8111-111111111111';
const escopo = { organizationId: ORG, actorId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d', role: 'owner' } as unknown as VerifiedOrganizationScope;
const ID = '33333333-3333-4333-8333-333333333333';

const escopada = (c: Consulta) => c.chamadas.some(([m, col, v]) => m === 'eq' && col === 'organizacao_id' && v === ORG);

beforeEach(() => {
  consultas.length = 0;
  respostas = [];
  tabelas = {};
  rpc.mockReset();
});

describe('clienteRepository — exclusão', () => {
  it('carrega por id + organização e verifica pedidos, LGPD, retenção e fornecedor, todos escopados', async () => {
    const { clienteRepository } = await import('./clienteRepository');
    respostas = [
      { data: { id: ID, bling_id: '5550001' }, error: null },
      { count: 0, error: null },
      { count: 0, error: null },
      { count: 0, error: null },
      { count: 2, error: null },
    ];

    const cliente = await clienteRepository.carregarParaExclusao(escopo, ID);

    expect(cliente).toEqual({ id: ID, blingId: '5550001', possuiHistorico: true });
    expect(consultas.map((c) => c.tabela)).toEqual([
      'clientes', 'pedidos', 'titular_solicitacoes', 'retention_legal_holds', 'titulos_financeiros',
    ]);
    expect(consultas.every(escopada)).toBe(true);
    expect(consultas[4]!.chamadas).toContainEqual(['eq', 'fornecedor_bling_id', '5550001']);
    expect(consultas[3]!.chamadas).toContainEqual(['is', 'liberado_em', null]);
  });

  describe('legal hold: só a categoria de cliente bloqueia', () => {
    const OUTRA_ORG = '22222222-2222-4222-8222-222222222222';
    const hold = (categoria: string, extra: Record<string, unknown> = {}) => ({
      organizacao_id: ORG, categoria, entidade_id: ID, liberado_em: null, ...extra,
    });

    async function historicoCom(holds: Array<Record<string, unknown>>) {
      const { clienteRepository } = await import('./clienteRepository');
      tabelas = { retention_legal_holds: holds };
      respostas = [{ data: { id: ID, bling_id: '' }, error: null }, { count: 0 }, { count: 0 }];
      return (await clienteRepository.carregarParaExclusao(escopo, ID))!.possuiHistorico;
    }

    it('hold ativo `cliente_final_pii` sobre o cliente bloqueia', async () => {
      expect(await historicoCom([hold('cliente_final_pii')])).toBe(true);
    });

    it('hold de OUTRA categoria com o mesmo entidade_id não bloqueia', async () => {
      expect(await historicoCom([hold('chatwoot_contato_pii')])).toBe(false);
    });

    it('hold já liberado, ou de outra organização, não bloqueia', async () => {
      expect(await historicoCom([
        hold('cliente_final_pii', { liberado_em: '2026-09-01T00:00:00Z' }),
        hold('cliente_final_pii', { organizacao_id: OUTRA_ORG }),
      ])).toBe(false);
    });

    it('a consulta nomeia a categoria explicitamente', async () => {
      await historicoCom([]);
      const consulta = consultas.find((c) => c.tabela === 'retention_legal_holds')!;
      expect(consulta.chamadas).toContainEqual(['eq', 'categoria', 'cliente_final_pii']);
    });
  });

  it('contato sem bling_id numérico não consulta fornecedor e é tratado como só do ORBITA', async () => {
    const { clienteRepository } = await import('./clienteRepository');
    respostas = [{ data: { id: ID, bling_id: '' }, error: null }, { count: 0 }, { count: 0 }, { count: 0 }];

    expect(await clienteRepository.carregarParaExclusao(escopo, ID)).toEqual({ id: ID, blingId: null, possuiHistorico: false });
    expect(consultas.map((c) => c.tabela)).not.toContain('titulos_financeiros');
  });

  it('cliente de outra organização não é encontrado: a consulta já nasce escopada', async () => {
    const { clienteRepository } = await import('./clienteRepository');
    respostas = [{ data: null, error: null }];
    expect(await clienteRepository.carregarParaExclusao(escopo, ID)).toBeNull();
    expect(escopada(consultas[0]!)).toBe(true);
  });

  it('a exclusão é escopada e devolve zero quando nenhuma linha saiu', async () => {
    const { clienteRepository } = await import('./clienteRepository');
    respostas = [{ data: [], error: null }];

    expect(await clienteRepository.excluir(escopo, ID)).toBe(0);
    expect(consultas[0]!.chamadas).toContainEqual(['delete']);
    expect(escopada(consultas[0]!)).toBe(true);
  });
});

/**
 * PRE-007A: as duas mutações saem pelas RPCs auditadas da migration 82. As
 * condições estruturais (tipo, `bling_id`, `pedido_id`, situação ativa) e a
 * transação única com o evento são provadas no pgTAP
 * `final/escrita_direta_financeira`; aqui se confere que organização e ator
 * vêm só do escopo verificado e que a falha não vira "zero linhas".
 */
describe('financeiroRepository — correção de título', () => {
  it('exclusão interna: RPC auditada com organização e ator do escopo, nenhum DELETE direto', async () => {
    const { financeiroRepository } = await import('./financeiroRepository');
    rpc.mockResolvedValue({ data: 1, error: null });

    expect(await financeiroRepository.excluirLancamentoInterno(escopo, ID, { correlationId: 'corr_1' })).toBe(1);
    expect(rpc).toHaveBeenCalledWith('excluir_lancamento_interno_auditado', {
      p_organizacao_id: ORG, p_ator_id: escopo.actorId, p_titulo_id: ID, p_correlation_id: 'corr_1',
    });
    expect(consultas).toEqual([]);
  });

  it('título que a RPC não removeu: zero linhas', async () => {
    const { financeiroRepository } = await import('./financeiroRepository');
    rpc.mockResolvedValue({ data: 0, error: null });
    expect(await financeiroRepository.excluirLancamentoInterno(escopo, ID, { correlationId: 'corr_1' })).toBe(0);
  });

  it('auditoria recusada pelo banco: a exclusão lança em vez de responder zero', async () => {
    const { financeiroRepository } = await import('./financeiroRepository');
    rpc.mockResolvedValue({ data: null, error: { code: 'P0001', message: 'evento recusado' } });
    await expect(financeiroRepository.excluirLancamentoInterno(escopo, ID, { correlationId: 'corr_1' })).rejects.toThrow();
  });

  it('cancelamento: RPC auditada com a evidência, sem UPDATE nem DELETE direto', async () => {
    const { financeiroRepository } = await import('./financeiroRepository');
    rpc.mockResolvedValue({ data: 0, error: null });

    expect(await financeiroRepository.marcarDespesaCancelada(escopo, ID, {
      correlationId: 'corr_2', evidencia: 'remoto_ausente',
    })).toBe(0);
    expect(rpc).toHaveBeenCalledWith('cancelar_despesa_local_auditada', {
      p_organizacao_id: ORG, p_ator_id: escopo.actorId, p_titulo_id: ID, p_correlation_id: 'corr_2', p_evidencia: 'remoto_ausente',
    });
    expect(consultas).toEqual([]);
  });

  it('sonda: só a recusa 22023 da própria RPC prova que a conclusão auditada existe', async () => {
    const { financeiroRepository } = await import('./financeiroRepository');
    rpc.mockResolvedValue({ data: null, error: { code: '22023', message: 'Organizacao, ator e titulo sao obrigatorios.' } });
    expect(await financeiroRepository.conclusaoDoCancelamentoDisponivel()).toBe(true);
    expect(rpc).toHaveBeenCalledWith('cancelar_despesa_local_auditada', {
      p_organizacao_id: null, p_ator_id: null, p_titulo_id: null, p_correlation_id: null, p_evidencia: null,
    });
    expect(consultas).toEqual([]);
  });

  it.each([
    ['função ausente (PGRST202)', { data: null, error: { code: 'PGRST202', message: 'not found' } }],
    ['banco fora', { data: null, error: { code: '', message: 'fetch failed' } }],
    ['sucesso inesperado', { data: 0, error: null }],
  ])('sonda: %s conta como indisponível', async (_caso, resposta) => {
    const { financeiroRepository } = await import('./financeiroRepository');
    rpc.mockResolvedValue(resposta);
    expect(await financeiroRepository.conclusaoDoCancelamentoDisponivel()).toBe(false);
  });

  it('auditoria recusada no cancelamento: lança', async () => {
    const { financeiroRepository } = await import('./financeiroRepository');
    rpc.mockResolvedValue({ data: null, error: { code: 'P0001', message: 'evento recusado' } });
    await expect(financeiroRepository.marcarDespesaCancelada(escopo, ID, {
      correlationId: 'corr_2', evidencia: 'remoto_cancelado',
    })).rejects.toThrow();
  });

  it('carga do título é escopada pela organização', async () => {
    const { financeiroRepository } = await import('./financeiroRepository');
    respostas = [{ data: null, error: null }];
    expect(await financeiroRepository.carregarTituloParaCorrecao(escopo, ID)).toBeNull();
    expect(escopada(consultas[0]!)).toBe(true);
  });
});
