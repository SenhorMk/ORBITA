import { describe, expect, it, vi } from 'vitest';

import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import { recomendarAlternativasDaTroca, type ResultadoDasAlternativas } from './alternativasDaTroca';

const uuid = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
const organizacaoId = uuid(1);
const escopo = { organizationId: organizacaoId, actorId: uuid(2), role: 'member' } as VerifiedOrganizationScope;
const pedido = { conversaId: uuid(3), pedidoId: uuid(4), itemId: uuid(5), quantidade: 2 };
const agora = new Date('2026-11-23T16:00:00.000Z');
const atual = '2026-11-23T15:00:00.000Z';
const antigo = '2026-11-21T15:00:00.000Z';
const compatibilidade = { familia: 'frasco', variante: '200-ml', versao: 'fixture-1' };

function candidato(n: number, precoCentavos: number | null = 4150) {
  return {
    organizacaoId, produtoId: uuid(n), nome: `Alternativa ${n}`,
    situacao: 'ativo' as 'ativo' | 'inativo' | 'arquivado', disponivel: 3,
    precoCentavos, moeda: 'BRL', precoSincronizadoEm: atual, estoqueSincronizadoEm: atual,
    compatibilidade: { ...compatibilidade },
  };
}
const fatos = {
  conversaId: pedido.conversaId, pedidoId: pedido.pedidoId, itemId: pedido.itemId, organizacaoId, provaValidaAte: '2026-11-23T17:00:00.000Z',
  original: { produtoId: uuid(6), quantidade: 2, precoCentavos: 4100, moeda: 'BRL', pedidoSincronizadoEm: atual, compatibilidade },
};

const consultar = async (candidatos: unknown[], entrada: unknown = pedido, alteracoes: Record<string, unknown> = {}) =>
  recomendarAlternativasDaTroca(escopo, entrada, { ler: async () => ({ ...fatos, ...alteracoes, candidatos }) }, agora);
function alternativas(r: ResultadoDasAlternativas) {
  expect(r.estado).toBe('ok');
  if (r.estado !== 'ok') throw new Error('Resultado esperado indisponível.');
  return r.valor.alternativas;
}

describe('MSG-012 — ranking somente leitura', () => {
  it.each([0, 1, 2, 3, 4])('limita o resultado quando há %i candidatos legítimos', async (n) => {
    const resultado = await consultar(Array.from({ length: n }, (_, i) => candidato(10 + i)));
    expect(alternativas(resultado)).toHaveLength(Math.min(n, 3));
  });

  it('aplica filtros duros antes da preferência e calcula o delta na moeda do pedido', async () => {
    const incompativel = { ...candidato(7), compatibilidade: { ...compatibilidade, variante: '500-ml' } };
    const dados = [
      incompativel,
      { ...candidato(8), organizacaoId: uuid(99) },
      { ...candidato(9), situacao: 'inativo' },
      { ...candidato(10), situacao: 'arquivado' },
      { ...candidato(11), disponivel: 1 },
      { ...candidato(12), estoqueSincronizadoEm: antigo },
      { ...candidato(13), precoSincronizadoEm: antigo },
      { ...candidato(14), moeda: 'USD' },
      { ...candidato(15), compatibilidade: null },
      { ...candidato(16), precoSincronizadoEm: null },
      candidato(17, null),
      candidato(18, 4099),
    ];
    const resultado = alternativas(await consultar(dados, { ...pedido, preferidoId: incompativel.produtoId }));
    expect(resultado).toEqual([expect.objectContaining({
      produtoId: uuid(18), precoUnitarioCentavos: 4099, deltaTotalCentavos: -2, moeda: 'BRL',
      razoes: ['compatibilidade_confirmada', 'delta_calculado'],
    })]);
  });

  it('ordena empate por UUID e só bonifica uma preferência elegível', async () => {
    const dados = [candidato(21), candidato(20), candidato(22, 4300), candidato(23)];
    const entrada = { ...pedido, preferidoId: uuid(22) };
    const r1 = alternativas(await consultar(dados, entrada));
    const r2 = alternativas(await consultar([...dados].reverse(), entrada));
    expect(r1).toEqual(r2);
    expect(r1.map((r) => r.produtoId)).toEqual([uuid(22), uuid(20), uuid(21)]);
    expect(r1[0].razoes).toContain('preferencia_informada');
  });

  it('descarta duplicação ambígua de uma alternativa', async () => {
    expect(alternativas(await consultar([candidato(20), candidato(20, 100), candidato(21)]))
      .map((a) => a.produtoId)).toEqual([uuid(21)]);
  });

  it.each([
    { organizacaoId: uuid(90) }, { conversaId: uuid(91) }, { pedidoId: uuid(92) },
    { itemId: uuid(93) }, { provaValidaAte: atual }, { provaValidaAte: null },
  ])('recusa um retrato fora do escopo ou sem prova vigente', async (alteracao) => {
    expect(await consultar([candidato(18)], pedido, alteracao)).toEqual({ estado: 'sem_prova' });
  });

  it('recusa referências extras no body antes de ler e trata indisponibilidade da fonte', async () => {
    const ler = vi.fn().mockRejectedValue(new Error('fonte indisponível'));
    const fonte = { ler };
    expect(await recomendarAlternativasDaTroca(escopo, { ...pedido, organizacaoId }, fonte, agora))
      .toEqual({ estado: 'entrada_invalida' });
    expect(ler).not.toHaveBeenCalled();
    expect(await recomendarAlternativasDaTroca(escopo, pedido, fonte, agora))
      .toEqual({ estado: 'indisponivel' });
  });
});
