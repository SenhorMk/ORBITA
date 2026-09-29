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

function construtor(tabela: string) {
  const consulta: Consulta = { tabela, chamadas: [] };
  consultas.push(consulta);
  const resposta = () => respostas.shift() ?? { data: null, error: null, count: 0 };
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

vi.mock('../lib/supabaseServer', () => ({
  supabaseServer: { from: (tabela: string) => construtor(tabela) },
}));

const ORG = '11111111-1111-4111-8111-111111111111';
const escopo = { organizationId: ORG, actorId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d', role: 'owner' } as unknown as VerifiedOrganizationScope;
const ID = '33333333-3333-4333-8333-333333333333';

const escopada = (c: Consulta) => c.chamadas.some(([m, col, v]) => m === 'eq' && col === 'organizacao_id' && v === ORG);

beforeEach(() => {
  consultas.length = 0;
  respostas = [];
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

describe('financeiroRepository — correção de título', () => {
  it('exclusão interna repete as condições estruturais no próprio DELETE', async () => {
    const { financeiroRepository } = await import('./financeiroRepository');
    respostas = [{ data: [{ id: ID }], error: null }];

    expect(await financeiroRepository.excluirLancamentoInterno(escopo, ID)).toBe(1);
    const chamadas = consultas[0]!.chamadas;
    expect(escopada(consultas[0]!)).toBe(true);
    expect(chamadas).toContainEqual(['eq', 'tipo', 'pagar']);
    expect(chamadas).toContainEqual(['is', 'bling_id', null]);
    expect(chamadas).toContainEqual(['is', 'pedido_id', null]);
  });

  it('cancelamento só move título ativo do Bling a `cancelado` — sem apagar', async () => {
    const { financeiroRepository } = await import('./financeiroRepository');
    respostas = [{ data: [], error: null }];

    expect(await financeiroRepository.marcarDespesaCancelada(escopo, ID)).toBe(0);
    const chamadas = consultas[0]!.chamadas;
    expect(chamadas).toContainEqual(['update', { situacao: 'cancelado' }]);
    expect(chamadas.some(([m]) => m === 'delete')).toBe(false);
    expect(escopada(consultas[0]!)).toBe(true);
    expect(chamadas).toContainEqual(['in', 'situacao', ['aberto', 'pago']]);
    expect(chamadas).toContainEqual(['not', 'bling_id', 'is', null]);
  });

  it('carga do título é escopada pela organização', async () => {
    const { financeiroRepository } = await import('./financeiroRepository');
    respostas = [{ data: null, error: null }];
    expect(await financeiroRepository.carregarTituloParaCorrecao(escopo, ID)).toBeNull();
    expect(escopada(consultas[0]!)).toBe(true);
  });
});
