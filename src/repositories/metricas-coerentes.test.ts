/**
 * Painel e Financeiro precisam contar a MESMA verdade sobre o mesmo dataset.
 *
 * Medido no staging em 07/09/2026: três pedidos de R$ 40 (um cancelado)
 * produziam R$ 120 de faturamento no painel, enquanto o Financeiro somava os
 * títulos por outro caminho. Estes testes fixam as duas pontas e a fronteira
 * de organização de cada agregação.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';

const ORG = '11111111-1111-4111-8111-111111111111';
const OUTRA_ORG = '22222222-2222-4222-8222-222222222222';
const scope = { organizationId: ORG, actorId: 'ator', role: 'owner' } as unknown as VerifiedOrganizationScope;

/** Os filtros que a consulta aplicou — é por eles que a fronteira se prova. */
const filtrosAplicados: Array<{ coluna: string; valor: unknown }> = [];
let linhasDeTitulos: Array<{ tipo: string; valor: string }> = [];

vi.mock('@/lib/supabaseServer', () => ({
  supabaseServer: {
    from: () => {
      const encadeavel: Record<string, unknown> = {
        select: () => encadeavel,
        order: () => encadeavel,
        eq: (coluna: string, valor: unknown) => {
          filtrosAplicados.push({ coluna, valor });
          return encadeavel;
        },
        then: (resolve: (r: unknown) => unknown) => resolve({ data: linhasDeTitulos, error: null }),
      };
      return encadeavel;
    },
  },
}));

const { financeiroRepository } = await import('./financeiroRepository');
const { pedidoRepository } = await import('./pedidoRepository');

const DATASET_STAGING = [
  { numero: '20', status: 'Cancelado', total: '40.00', data: '2026-09-02T03:00:00.000Z' },
  { numero: '21', status: 'Pendente', total: '40.00', data: '2026-09-07T03:00:00.000Z' },
  { numero: '22', status: 'Pendente', total: '40.00', data: '2026-09-07T03:00:00.000Z' },
];

describe('estatísticas do painel', () => {
  const AGORA = new Date('2026-09-07T12:00:00.000Z');

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('o cancelado não entra no faturamento, mas continua contado como cancelado', async () => {
    vi.spyOn(pedidoRepository, 'getAllEnriched').mockResolvedValue(
      DATASET_STAGING as unknown as Awaited<ReturnType<typeof pedidoRepository.getAllEnriched>>,
    );

    const stats = await pedidoRepository.getDashboardStats(scope, AGORA);

    // Era R$ 120 — o cancelado inflava o card e, com ele, o lucro estimado.
    expect(stats.faturamento30).toBe(80);
    // A LISTA não muda: o pedido continua existindo e sendo contado por status.
    expect(stats.total).toBe(3);
    expect(stats.cancelados).toBe(1);
    expect(stats.pendentes).toBe(2);
  });

  it('a janela anterior é calculada de verdade, não fixada no código', async () => {
    vi.spyOn(pedidoRepository, 'getAllEnriched').mockResolvedValue([
      { status: 'Entregue', total: '100.00', data: '2026-09-05T00:00:00.000Z' },
      { status: 'Entregue', total: '70.00', data: '2026-07-25T00:00:00.000Z' },
      { status: 'Cancelado', total: '999.00', data: '2026-07-26T00:00:00.000Z' },
    ] as unknown as Awaited<ReturnType<typeof pedidoRepository.getAllEnriched>>);

    const stats = await pedidoRepository.getDashboardStats(scope, AGORA);

    expect(stats.faturamento30).toBe(100);
    expect(stats.faturamento30Anterior).toBe(70);
  });

  it('lê pedidos apenas pelo escopo verificado recebido', async () => {
    const espiao = vi.spyOn(pedidoRepository, 'getAllEnriched').mockResolvedValue([]);
    await pedidoRepository.getDashboardStats(scope, AGORA);
    expect(espiao).toHaveBeenCalledWith(scope);
  });
});

describe('resumo financeiro', () => {
  beforeEach(() => {
    filtrosAplicados.length = 0;
    linhasDeTitulos = [];
  });

  it('entradas, saídas e saldo saem dos TÍTULOS — o pedido não é somado de novo', async () => {
    // O dataset real do staging: 3 títulos a receber pagos e 4 a pagar pagos.
    linhasDeTitulos = [
      { tipo: 'receber', valor: '40.00' },
      { tipo: 'receber', valor: '40.00' },
      { tipo: 'receber', valor: '40.00' },
      { tipo: 'pagar', valor: '20.00' },
      { tipo: 'pagar', valor: '50.00' },
      { tipo: 'pagar', valor: '20.00' },
      { tipo: 'pagar', valor: '50.00' },
    ];

    const resumo = await financeiroRepository.getResumo(scope);

    expect(resumo.receitas).toBe(120);
    expect(resumo.despesas).toBe(140);
    expect(resumo.saldo).toBe(-20);
  });

  it('cada título entra uma vez só', async () => {
    linhasDeTitulos = [{ tipo: 'receber', valor: '40.00' }];
    const resumo = await financeiroRepository.getResumo(scope);
    expect(resumo.receitas).toBe(40);
  });

  it('a agregação é escopada à organização e só considera título pago', async () => {
    await financeiroRepository.getResumo(scope);

    expect(filtrosAplicados).toContainEqual({ coluna: 'organizacao_id', valor: ORG });
    expect(filtrosAplicados).toContainEqual({ coluna: 'situacao', valor: 'pago' });
    expect(filtrosAplicados.some((f) => f.valor === OUTRA_ORG)).toBe(false);
  });
});
