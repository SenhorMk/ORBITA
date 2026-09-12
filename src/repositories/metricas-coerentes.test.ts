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
let linhasDeTitulos: Array<{ tipo: string; valor: string; situacao?: string }> = [];

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
        in: (coluna: string, valor: unknown) => {
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
    //
    // A `situacao` é explícita em cada linha, e passou a ser obrigatória para o
    // caso medir algo: o recorte fecha por omissão, então uma linha sem
    // situação — que a consulta real nunca devolve, porque filtra por ela —
    // ficaria fora do total. Dizer "pagos" no comentário e omitir o campo no
    // dado era o teste descrevendo um dataset que ele não montava.
    linhasDeTitulos = [
      { tipo: 'receber', valor: '40.00', situacao: 'pago' },
      { tipo: 'receber', valor: '40.00', situacao: 'pago' },
      { tipo: 'receber', valor: '40.00', situacao: 'pago' },
      { tipo: 'pagar', valor: '20.00', situacao: 'pago' },
      { tipo: 'pagar', valor: '50.00', situacao: 'pago' },
      { tipo: 'pagar', valor: '20.00', situacao: 'pago' },
      { tipo: 'pagar', valor: '50.00', situacao: 'pago' },
    ];

    const resumo = await financeiroRepository.getResumo(scope);

    expect(resumo.receitas).toBe(120);
    expect(resumo.despesas).toBe(140);
    expect(resumo.saldo).toBe(-20);
  });

  it('cada título entra uma vez só', async () => {
    linhasDeTitulos = [{ tipo: 'receber', valor: '40.00', situacao: 'pago' }];
    const resumo = await financeiroRepository.getResumo(scope);
    expect(resumo.receitas).toBe(40);
  });

  it('a agregação é escopada à organização e recorta pelas situações ATIVAS', async () => {
    // Era `.eq('situacao', 'pago')`. A tabela e os graficos sempre contaram
    // `aberto` tambem, e os cards nao — era esse o defeito: lancar uma despesa
    // em aberto movia o grafico e deixava os cards parados.
    await financeiroRepository.getResumo(scope);

    expect(filtrosAplicados).toContainEqual({ coluna: 'organizacao_id', valor: ORG });
    expect(filtrosAplicados).toContainEqual({ coluna: 'situacao', valor: ['aberto', 'pago'] });
    expect(filtrosAplicados.some((f) => f.valor === OUTRA_ORG)).toBe(false);
  });
});

describe('estados terminais do título', () => {
  beforeEach(() => {
    filtrosAplicados.length = 0;
    linhasDeTitulos = [];
  });

  it('`cancelado` e `estornado` não entram em Total Entradas', async () => {
    // O dataset do staging depois da convergência: duas vendas válidas e uma
    // revertida, que continua na tabela.
    linhasDeTitulos = [
      { tipo: 'receber', valor: '40.00', situacao: 'pago' },
      { tipo: 'receber', valor: '40.00', situacao: 'pago' },
      { tipo: 'receber', valor: '40.00', situacao: 'estornado' },
      { tipo: 'receber', valor: '25.00', situacao: 'cancelado' },
    ];

    const resumo = await financeiroRepository.getResumo(scope);

    expect(resumo.receitas).toBe(80);
  });

  it('a troca fecha em R$ 60: a venda de R$ 40 estornada não soma com a de R$ 60', async () => {
    linhasDeTitulos = [
      { tipo: 'receber', valor: '40.00', situacao: 'estornado' },
      { tipo: 'receber', valor: '60.00', situacao: 'pago' },
    ];

    const resumo = await financeiroRepository.getResumo(scope);

    expect(resumo.receitas).toBe(60);
  });
});

/**
 * O defeito reproduzido no staging: despesa lancada em aberto mudava tabela e
 * grafico, e os tres cards nao se moviam. Os cards liam `pago`; a tabela e os
 * graficos liam `pago` + `aberto`. Duas respostas para a mesma pergunta, na
 * mesma tela — e num painel de dinheiro isso le como numero errado.
 */
describe('os cards contam a mesma coisa que a tabela e os gráficos', () => {
  beforeEach(() => {
    filtrosAplicados.length = 0;
    linhasDeTitulos = [];
  });

  it('uma despesa em ABERTO entra em Total Saídas', async () => {
    linhasDeTitulos = [{ tipo: 'pagar', valor: '150.00', situacao: 'aberto' }];

    const resumo = await financeiroRepository.getResumo(scope);

    expect(resumo.despesas).toBe(150);
  });

  it('uma receita em ABERTO entra em Total Entradas', async () => {
    linhasDeTitulos = [{ tipo: 'receber', valor: '90.00', situacao: 'aberto' }];

    const resumo = await financeiroRepository.getResumo(scope);

    expect(resumo.receitas).toBe(90);
  });

  it('PAGO continua entrando, ao lado do aberto', async () => {
    linhasDeTitulos = [
      { tipo: 'receber', valor: '100.00', situacao: 'pago' },
      { tipo: 'receber', valor: '50.00', situacao: 'aberto' },
      { tipo: 'pagar', valor: '30.00', situacao: 'pago' },
      { tipo: 'pagar', valor: '20.00', situacao: 'aberto' },
    ];

    const resumo = await financeiroRepository.getResumo(scope);

    expect(resumo.receitas).toBe(150);
    expect(resumo.despesas).toBe(50);
  });

  it('CANCELADO não entra em nenhum dos totais', async () => {
    linhasDeTitulos = [
      { tipo: 'receber', valor: '70.00', situacao: 'cancelado' },
      { tipo: 'pagar', valor: '80.00', situacao: 'cancelado' },
    ];

    const resumo = await financeiroRepository.getResumo(scope);

    expect(resumo).toEqual({ receitas: 0, despesas: 0, saldo: 0 });
  });

  it('ESTORNADO não entra em nenhum dos totais', async () => {
    linhasDeTitulos = [
      { tipo: 'receber', valor: '70.00', situacao: 'estornado' },
      { tipo: 'pagar', valor: '80.00', situacao: 'estornado' },
    ];

    const resumo = await financeiroRepository.getResumo(scope);

    expect(resumo).toEqual({ receitas: 0, despesas: 0, saldo: 0 });
  });

  it('saldo é entradas menos saídas, com aberto e pago misturados', async () => {
    linhasDeTitulos = [
      { tipo: 'receber', valor: '200.00', situacao: 'pago' },
      { tipo: 'receber', valor: '100.00', situacao: 'aberto' },
      { tipo: 'pagar', valor: '120.00', situacao: 'aberto' },
      { tipo: 'pagar', valor: '30.00', situacao: 'pago' },
      // Os terminais ficam no historico e fora da conta.
      { tipo: 'receber', valor: '999.00', situacao: 'cancelado' },
      { tipo: 'pagar', valor: '999.00', situacao: 'estornado' },
    ];

    const resumo = await financeiroRepository.getResumo(scope);

    expect(resumo.receitas).toBe(300);
    expect(resumo.despesas).toBe(150);
    expect(resumo.saldo).toBe(resumo.receitas - resumo.despesas);
    expect(resumo.saldo).toBe(150);
  });

  it('uma situação desconhecida fica fora: o recorte fecha por omissão', async () => {
    // Incluir por engano num painel de dinheiro e pior que excluir por engano:
    // o segundo aparece como numero faltando, o primeiro como numero errado.
    linhasDeTitulos = [{ tipo: 'receber', valor: '500.00', situacao: 'situacao-que-o-bling-inventou' }];

    const resumo = await financeiroRepository.getResumo(scope);

    expect(resumo.receitas).toBe(0);
  });
});
