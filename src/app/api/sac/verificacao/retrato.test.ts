import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RetratoDoPedido } from '@/lib/integrations/contratoDoRetrato';
import type { OrganizationContextResult } from '@/lib/organizationAuthorization';
import { VerificacaoIndisponivel } from '@/services/sac/clienteVerificado';
import type { ResultadoDoRetrato } from '@/services/sac/retratoDoPedido';

import { criarRotasDaVerificacao, type DependenciasDaVerificacao } from './handlers';

const ORG_A = '22222222-2222-4222-8222-222222222222';
const ORG_B = '99999999-9999-4999-8999-999999999999';
const USUARIO = '70000000-0000-4000-8000-000000000001';
const CONVERSA = '44444444-4444-4444-8444-444444444444';
const PEDIDO = '88888888-8888-4888-8888-888888888888';
const URL_RETRATO = 'https://orbita.test/api/sac/pedidos/retrato';

const frescor = { situacao: 'atual', sincronizadoEm: '2026-11-12T11:00:00+00:00', motivo: null } as const;
const retrato: RetratoDoPedido = {
  pedido: { id: PEDIDO, numero: '1001', data: '2026-11-08T10:00:00+00:00', status: 'Enviado', total: 99.8, frete: 0, desconto: null, formaDePagamento: 'Pix' },
  itens: [{
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', produtoId: null, nome: 'Camiseta Sintética', codigo: null, quantidade: 2, valorUnitario: 49.9,
    estoque: { situacao: 'desconhecido', disponivel: null },
  }],
  totalDeItens: 1,
  itensOmitidos: 0,
  pagamento: { situacao: 'desconhecido', vencido: false, valor: null, vencimento: null, pagoEm: null },
  rastreio: { situacao: 'desconhecido', motivo: 'sem_fonte' },
  frescor: { pedido: frescor, estoque: frescor, pagamento: frescor },
};

function sessao(capabilities: readonly string[]): OrganizationContextResult {
  return {
    _tag: 'OrganizationContextResolved',
    context: { actorId: USUARIO, organizationId: ORG_A, role: 'member', capabilities: new Set(capabilities) },
  } as unknown as OrganizationContextResult;
}

function deps(resultado: ResultadoDoRetrato = { _tag: 'Retrato', retrato }) {
  const nunca = vi.fn(async () => { throw new Error('não deveria ser chamado'); });
  return {
    resolverContexto: vi.fn(async () => sessao(['organization:access'])),
    ler: nunca,
    confirmar: nunca,
    revogar: nunca,
    consultaDePedidos: vi.fn(() => { throw new Error('não deveria ser chamado'); }),
    retrato: vi.fn<DependenciasDaVerificacao['retrato']>(async () => resultado),
  };
}

const get = (query: string) => new Request(`${URL_RETRATO}?${query}`, { headers: { 'x-correlation-id': 'corr-retrato-1' } });

afterEach(() => vi.restoreAllMocks());

describe('GET /api/sac/pedidos/retrato', () => {
  it('a organização vem da sessão; a resposta segue o contrato e desconhecido continua desconhecido', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const d = deps();
    const res = await criarRotasDaVerificacao(d).lerRetrato(get(`conversaId=${CONVERSA}&pedidoId=${PEDIDO}&organizacaoId=${ORG_B}`));
    const corpo = await res.json();

    expect(res.status).toBe(200);
    expect(corpo).toEqual({ success: true, versao: 1, retrato });
    expect(d.retrato).toHaveBeenCalledWith(expect.objectContaining({ organizationId: ORG_A, actorId: USUARIO }), CONVERSA, PEDIDO);
    expect(corpo.retrato.pagamento.situacao).toBe('desconhecido');
    expect(corpo.retrato.itens[0].estoque.disponivel).toBeNull();
    const evento = JSON.parse(String(info.mock.calls[0][0]));
    expect(evento).toMatchObject({
      message: 'sac.retrato_do_pedido', outcome: 'retrato', correlationId: 'corr-retrato-1', organizacaoId: ORG_A, conversaId: CONVERSA,
      frescor: { pedido: 'atual', estoque: 'atual', pagamento: 'atual' },
    });
    expect(JSON.stringify(evento)).not.toMatch(/Camiseta|99\.8|1001/u);
  });

  it.each([
    [{ _tag: 'SemProva', proximoPasso: 'encaminhar_para_humano' }, 409, 'sem_prova'],
    [{ _tag: 'NaoEncontrado' }, 404, 'nao_encontrado'],
    [{ _tag: 'ConversaNaoEncontrada' }, 404, 'conversa_nao_encontrada'],
  ] as const)('recusa %j: status %i, sem retrato, registrada', async (resultado, status, motivo) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await criarRotasDaVerificacao(deps(resultado)).lerRetrato(get(`conversaId=${CONVERSA}&pedidoId=${PEDIDO}`));
    const corpo = await res.json();
    expect(res.status).toBe(status);
    expect(corpo).toMatchObject({ success: false, motivo });
    expect(corpo).not.toHaveProperty('retrato');
    expect(JSON.parse(String(warn.mock.calls[0][0]))).toMatchObject({ message: 'sac.retrato_do_pedido', outcome: motivo, correlationId: 'corr-retrato-1' });
  });

  it.each([
    [`conversaId=${CONVERSA}`],
    [`pedidoId=${PEDIDO}`],
    [`conversaId=70&pedidoId=${PEDIDO}`],
    [`conversaId=${CONVERSA}&pedidoId=1001`],
  ])('parâmetros inválidos %s: 400 sem consultar', async (query) => {
    const d = deps();
    expect((await criarRotasDaVerificacao(d).lerRetrato(get(query))).status).toBe(400);
    expect(d.retrato).not.toHaveBeenCalled();
  });

  it('sem a capability de atendimento: 403 e nada consultado', async () => {
    const d = deps();
    d.resolverContexto.mockResolvedValue(sessao([]));
    expect((await criarRotasDaVerificacao(d).lerRetrato(get(`conversaId=${CONVERSA}&pedidoId=${PEDIDO}`))).status).toBe(403);
    expect(d.retrato).not.toHaveBeenCalled();
  });

  it('banco fora ou resposta fora do contrato: 503, nunca retrato vazio', async () => {
    const d = deps();
    d.retrato.mockRejectedValue(new VerificacaoIndisponivel());
    const res = await criarRotasDaVerificacao(d).lerRetrato(get(`conversaId=${CONVERSA}&pedidoId=${PEDIDO}`));
    expect(res.status).toBe(503);
    expect(await res.json()).not.toHaveProperty('retrato');
  });

  it('retrato que o servidor não consegue validar não sai', async () => {
    const d = deps({ _tag: 'Retrato', retrato: { ...retrato, pedido: { ...retrato.pedido, cpf: '123.456.789-09' } } as unknown as RetratoDoPedido });
    await expect(criarRotasDaVerificacao(d).lerRetrato(get(`conversaId=${CONVERSA}&pedidoId=${PEDIDO}`))).rejects.toThrow();
  });
});

describe('superfície', () => {
  it('a rota do retrato exporta só GET', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project-ref.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'public-key-12345678901234567890';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'server-key-12345678901234567890';
    const rota = await import('../pedidos/retrato/route');
    expect(Object.keys(rota).filter((k) => /^(GET|POST|PUT|PATCH|DELETE)$/u.test(k))).toEqual(['GET']);
  });
});
