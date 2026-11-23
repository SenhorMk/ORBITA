import { describe, expect, it, vi } from 'vitest';
import type { NextResponse } from 'next/server';
import type { RetratoDoPedido } from '@/lib/integrations/contratoDoRetrato';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import type { ResultadoDoRetrato } from '@/services/sac/retratoDoPedido';
import { criarRotaDaPrevia } from './handler';

const uuid = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
const escopo = { organizationId: uuid(1), actorId: uuid(2), role: 'member' } as VerifiedOrganizationScope;
const conversaId = uuid(3);
const pedidoId = uuid(4);
const itemId = uuid(5);
const casoId = uuid(6);
const ts = '2026-11-23T12:00:00.000Z';
const atual = { situacao: 'atual', sincronizadoEm: ts, motivo: null } as const;
const retrato: RetratoDoPedido = {
  pedido: { id: pedidoId, numero: '1001', data: ts, status: 'Enviado', total: 81.98, frete: null, desconto: null, formaDePagamento: null },
  itens: [{ id: itemId, produtoId: uuid(7), nome: 'Produto sintético', codigo: 'DEMO', quantidade: 2, valorUnitario: 40.99,
    estoque: { situacao: 'desconhecido', disponivel: null } }],
  totalDeItens: 1, itensOmitidos: 0,
  pagamento: { situacao: 'desconhecido', vencido: false, valor: null, vencimento: null, pagoEm: null },
  rastreio: { situacao: 'desconhecido', motivo: 'sem_fonte' },
  frescor: { pedido: atual, estoque: atual, pagamento: atual },
};

const solicitar = (body: unknown) => new Request('https://orbita.test/api/sac/trocas/previa', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const entrada = { conversaId, pedidoId, itemId, tipo: 'troca', quantidade: 1, motivo: 'avaria', substitutoPretendido: 'Outro sintético' };
function fixture(resposta: ResultadoDoRetrato = { _tag: 'Retrato', retrato }) {
  const leituras = {
    casoAberto: vi.fn(async (_scope: VerifiedOrganizationScope, conversa: string) => conversa === conversaId ? casoId : null),
    retrato: vi.fn(async () => resposta),
  };
  const resolver = vi.fn(async () => ({ _tag: 'RequestScopeResolved', scope: escopo } as const));
  return { leituras, executar: criarRotaDaPrevia(resolver, leituras) };
}

describe('MSG-015 prévia somente leitura', () => {
  it('devolve o item verificado em centavos e mantém a decisão bloqueada sem D7', async () => {
    const f = fixture();
    const resposta = await f.executar(solicitar(entrada));
    expect(resposta.status).toBe(200);
    expect(resposta.headers.get('cache-control')).toBe('no-store');
    expect(f.leituras.casoAberto).toHaveBeenCalledWith(escopo, conversaId);
    expect(f.leituras.retrato).toHaveBeenCalledWith(escopo, conversaId, pedidoId);
    expect(await resposta.json()).toMatchObject({
      estado: 'requer_compatibilidade', podeAprovar: false, casoId, rastreio: 'sem_fonte',
      pendencias: ['ranking', 'politica'],
      pedido: { item: { id: itemId, precoUnitarioCentavos: 4099, moeda: 'BRL' } },
    });
  });

  it('pede o dado ausente e deixa o pedido desconhecido', async () => {
    const f = fixture();
    const resposta = await f.executar(solicitar({ conversaId, tipo: 'devolucao' }));
    expect(await resposta.json()).toMatchObject({
      pedido: null, estado: 'incompleta', podeAprovar: false, proximaPergunta: { campo: 'pedido' },
    });
    expect(f.leituras.retrato).not.toHaveBeenCalled();
  });

  it('separa devolução completa, que depende de política, de troca com ranking não comprovado', async () => {
    const f = fixture();
    const resposta = await f.executar(solicitar({ ...entrada, tipo: 'devolucao' }));
    expect(await resposta.json()).toMatchObject({
      estado: 'requer_politica', pendencias: ['politica'], podeAprovar: false, proximaPergunta: null,
    });
  });

  it('mantém todas as pendências de coleta e de elegibilidade em ordem verificável', async () => {
    const f = fixture();
    const resposta = await f.executar(solicitar({ conversaId, pedidoId, tipo: 'troca' }));
    expect(await resposta.json()).toMatchObject({
      estado: 'incompleta', pendencias: ['item', 'quantidade', 'motivo', 'substituto', 'ranking', 'politica'],
      proximaPergunta: { campo: 'item' }, podeAprovar: false,
    });
  });

  it('não revela pedido sem prova vigente', async () => {
    const f = fixture({ _tag: 'SemProva', proximoPasso: 'encaminhar_para_humano' });
    const resposta = await f.executar(solicitar(entrada));
    expect(await resposta.json()).toMatchObject({ pedido: null, proximaPergunta: null, pendencias: ['confirmar_cliente', 'ranking', 'politica'] });
  });

  it('indica pendência de frescor e não usa o preço antigo', async () => {
    const f = fixture({ _tag: 'Retrato', retrato: {
      ...retrato, frescor: { ...retrato.frescor, pedido: { situacao: 'desatualizado', sincronizadoEm: ts, motivo: 'antiga' } },
    } });
    const resposta = await f.executar(solicitar(entrada));
    expect(await resposta.json()).toMatchObject({ pedido: null, estado: 'incompleta', pendencias: ['frescor', 'ranking', 'politica'] });
  });

  it('recusa adulteração de escopo e ação comercial antes de consultar', async () => {
    const f = fixture();
    for (const dados of [{ ...entrada, organizacaoId: uuid(99) }, { ...entrada, acao: 'aprovar' },
      { ...entrada, precoUnitarioCentavos: 1 }, { ...entrada, quantidade: 1.1 }]) {
      expect((await f.executar(solicitar(dados))).status).toBe(400);
    }
    expect(f.leituras.casoAberto).not.toHaveBeenCalled();
    expect(f.leituras.retrato).not.toHaveBeenCalled();
  });

  it('recusa conversa, pedido ou item fora do escopo verificado', async () => {
    const f = fixture();
    expect((await f.executar(solicitar({ ...entrada, conversaId: uuid(99) }))).status).toBe(404);
    expect(f.leituras.retrato).not.toHaveBeenCalled();
    expect((await f.executar(solicitar({ ...entrada, itemId: uuid(99) }))).status).toBe(404);
    expect((await f.executar(solicitar({ ...entrada, pedidoId: uuid(99) }))).status).toBe(404);
  });

  it('recusa sessão inválida sem leitura e traduz falha do port sem expor detalhes', async () => {
    const f = fixture();
    const negada = criarRotaDaPrevia(async () => ({
      _tag: 'RequestScopeDenied', response: new Response(null, { status: 401 }) as NextResponse,
    }), f.leituras);
    expect((await negada(solicitar(entrada))).status).toBe(401);
    expect(f.leituras.casoAberto).not.toHaveBeenCalled();
    f.leituras.retrato.mockRejectedValue(new Error('detalhe interno'));
    const r = await f.executar(solicitar(entrada));
    expect(r.status).toBe(503);
    expect(await r.text()).not.toContain('detalhe interno');
  });
});
