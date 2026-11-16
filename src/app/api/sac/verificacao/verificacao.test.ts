import { afterEach, describe, expect, it, vi } from 'vitest';

import type { OrganizationContextResult } from '@/lib/organizationAuthorization';
import { VerificacaoIndisponivel, type ConsultaDePedidos, type ResultadoDaConsulta } from '@/services/sac/clienteVerificado';

import { criarRotasDaVerificacao, type DependenciasDaVerificacao } from './handlers';

const ORG_A = '22222222-2222-4222-8222-222222222222';
const ORG_B = '99999999-9999-4999-8999-999999999999';
const USUARIO = '70000000-0000-4000-8000-000000000001';
const CONVERSA = '44444444-4444-4444-8444-444444444444';
const CLIENTE = '55555555-5555-4555-8555-555555555555';
const COMANDO = '66666666-6666-4666-8666-666666666666';
const VINCULO = '77777777-7777-4777-8777-777777777777';
const PEDIDO = '88888888-8888-4888-8888-888888888888';
const URL_VERIFICACAO = 'https://orbita.test/api/sac/verificacao';
const URL_PEDIDOS = 'https://orbita.test/api/sac/pedidos';

function sessao(capabilities: readonly string[]): OrganizationContextResult {
  return {
    _tag: 'OrganizationContextResolved',
    context: { actorId: USUARIO, organizationId: ORG_A, role: 'member', capabilities: new Set(capabilities) },
  } as unknown as OrganizationContextResult;
}

const semProva = {
  _tag: 'Encontrada' as const,
  verificacao: { estado: 'sem_prova' as const, cliente: null, verificadoEm: null, expiraEm: null, totalDeCandidatos: 1, consultaPorNumeroBloqueada: false },
  candidatos: [{ clienteId: CLIENTE, nome: 'Ana Sintética', documentoFinal: '09' }],
};
const umPedido = { id: PEDIDO, numero: '1001', data: '2026-11-08T10:00:00+00:00', status: 'Pendente', total: 10 };

function deps(contexto: OrganizationContextResult, consulta: ResultadoDaConsulta = { _tag: 'Pedidos', pedidos: [umPedido] }) {
  const pedidos: ConsultaDePedidos = { listar: vi.fn(async () => consulta), localizar: vi.fn(async () => consulta) };
  return {
    resolverContexto: vi.fn(async () => contexto),
    ler: vi.fn<DependenciasDaVerificacao['ler']>(async () => semProva),
    confirmar: vi.fn<DependenciasDaVerificacao['confirmar']>(async () => ({
      _tag: 'Confirmado', duplicado: false, vinculoId: VINCULO, expiraEm: '2026-11-11T10:00:00+00:00',
    })),
    revogar: vi.fn<DependenciasDaVerificacao['revogar']>(async () => ({ _tag: 'Revogada' })),
    consultaDePedidos: vi.fn<DependenciasDaVerificacao['consultaDePedidos']>(() => pedidos),
    retrato: vi.fn<DependenciasDaVerificacao['retrato']>(async () => ({ _tag: 'NaoEncontrado' })),
    pedidos,
  };
}

const post = (url: string, corpo: unknown) => new Request(url, { method: 'POST', body: JSON.stringify(corpo), headers: { 'x-correlation-id': 'corr-teste-1' } });

afterEach(() => vi.restoreAllMocks());

describe('autorização: a mesma para as cinco rotas', () => {
  const chamadas = [
    (r: ReturnType<typeof criarRotasDaVerificacao>) => r.lerVerificacao(new Request(`${URL_VERIFICACAO}?conversaId=${CONVERSA}`)),
    (r: ReturnType<typeof criarRotasDaVerificacao>) => r.alterarVerificacao(post(URL_VERIFICACAO, { acao: 'confirmar', conversaId: CONVERSA, commandId: COMANDO, clienteId: CLIENTE })),
    (r: ReturnType<typeof criarRotasDaVerificacao>) => r.listarPedidos(new Request(`${URL_PEDIDOS}?conversaId=${CONVERSA}`)),
    (r: ReturnType<typeof criarRotasDaVerificacao>) => r.localizarPedido(post(URL_PEDIDOS, { conversaId: CONVERSA, numero: '1001' })),
    (r: ReturnType<typeof criarRotasDaVerificacao>) => r.lerRetrato(new Request(`${URL_PEDIDOS}/retrato?conversaId=${CONVERSA}&pedidoId=${PEDIDO}`)),
  ];

  it('sem sessão, sem vínculo ou autorização fora: nega e não chega ao banco', async () => {
    for (const [tag, esperado] of [['SessionMissing', 401], ['OrganizationAccessDenied', 403], ['OrganizationStoreUnavailable', 503]] as const) {
      for (const chamar of chamadas) {
        const d = deps({ _tag: tag } as OrganizationContextResult);
        expect((await chamar(criarRotasDaVerificacao(d))).status).toBe(esperado);
        expect(d.ler).not.toHaveBeenCalled();
        expect(d.confirmar).not.toHaveBeenCalled();
        expect(d.consultaDePedidos).not.toHaveBeenCalled();
        expect(d.retrato).not.toHaveBeenCalled();
      }
    }
  });

  it('sem a capability de atendimento: 403 e nada consultado', async () => {
    for (const chamar of chamadas) {
      const d = deps(sessao([]));
      expect((await chamar(criarRotasDaVerificacao(d))).status).toBe(403);
      expect(d.ler).not.toHaveBeenCalled();
      expect(d.confirmar).not.toHaveBeenCalled();
      expect(d.consultaDePedidos).not.toHaveBeenCalled();
      expect(d.retrato).not.toHaveBeenCalled();
    }
  });
});

describe('GET /api/sac/verificacao', () => {
  it('a organização vem da sessão; a resposta segue o contrato e não leva documento inteiro nem telefone', async () => {
    const d = deps(sessao(['organization:access']));
    const res = await criarRotasDaVerificacao(d).lerVerificacao(new Request(`${URL_VERIFICACAO}?conversaId=${CONVERSA}&organizacaoId=${ORG_B}`));
    const corpo = await res.json();

    expect(res.status).toBe(200);
    expect(d.ler).toHaveBeenCalledWith(expect.objectContaining({ organizationId: ORG_A, actorId: USUARIO }), CONVERSA);
    expect(corpo).toEqual({ success: true, versao: 1, verificacao: semProva.verificacao, candidatos: semProva.candidatos });
    expect(JSON.stringify(corpo)).not.toMatch(/cpf|telefone|phone|123\.456/u);
  });

  it('conversa inválida: 400; de outra organização: 404; banco fora: 503', async () => {
    const invalida = deps(sessao(['organization:access']));
    expect((await criarRotasDaVerificacao(invalida).lerVerificacao(new Request(`${URL_VERIFICACAO}?conversaId=70`))).status).toBe(400);
    expect(invalida.ler).not.toHaveBeenCalled();

    const alheia = deps(sessao(['organization:access']));
    alheia.ler.mockResolvedValue({ _tag: 'ConversaNaoEncontrada' });
    expect((await criarRotasDaVerificacao(alheia).lerVerificacao(new Request(`${URL_VERIFICACAO}?conversaId=${CONVERSA}`))).status).toBe(404);

    const fora = deps(sessao(['organization:access']));
    fora.ler.mockRejectedValue(new VerificacaoIndisponivel());
    expect((await criarRotasDaVerificacao(fora).lerVerificacao(new Request(`${URL_VERIFICACAO}?conversaId=${CONVERSA}`))).status).toBe(503);
  });
});

describe('POST /api/sac/verificacao', () => {
  it('confirmar: organização e ator da sessão; o que o corpo disser sobre eles é ignorado', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const d = deps(sessao(['organization:access']));
    const res = await criarRotasDaVerificacao(d).alterarVerificacao(post(URL_VERIFICACAO, {
      acao: 'confirmar', conversaId: CONVERSA, commandId: COMANDO, clienteId: CLIENTE, organizacaoId: ORG_B, atorId: ORG_B,
    }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, duplicado: false, expiraEm: '2026-11-11T10:00:00+00:00' });
    expect(d.confirmar).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG_A, actorId: USUARIO }),
      { conversaId: CONVERSA, commandId: COMANDO, clienteId: CLIENTE },
    );
    const evento = JSON.parse(String(info.mock.calls[0][0]));
    expect(evento).toMatchObject({
      message: 'sac.verificacao', acao: 'confirmar', outcome: 'confirmado', correlationId: 'corr-teste-1',
      organizacaoId: ORG_A, actorId: USUARIO, conversaId: CONVERSA, vinculoId: VINCULO,
    });
  });

  it.each([
    [{ acao: 'confirmar', conversaId: CONVERSA, commandId: COMANDO }],
    [{ acao: 'confirmar', conversaId: CONVERSA, commandId: 'x', clienteId: CLIENTE }],
    [{ acao: 'confirmar', conversaId: CONVERSA, commandId: COMANDO, clienteId: '123.456.789-09' }],
    [{ acao: 'liberar', conversaId: CONVERSA }],
    [{ acao: 'revogar' }],
    [null],
  ])('entrada inválida %j: 400 sem chamar o banco', async (corpo) => {
    const d = deps(sessao(['organization:access']));
    const res = await criarRotasDaVerificacao(d).alterarVerificacao(post(URL_VERIFICACAO, corpo));
    expect(res.status).toBe(400);
    expect(d.confirmar).not.toHaveBeenCalled();
    expect(d.revogar).not.toHaveBeenCalled();
  });

  it.each([
    [{ _tag: 'ClienteNaoEncontrado' }, 404, 'cliente_nao_encontrado'],
    [{ _tag: 'ConversaNaoEncontrada' }, 404, 'conversa_nao_encontrada'],
    [{ _tag: 'ConflitoDeComando' }, 409, 'conflito_comando'],
    [{ _tag: 'SemVinculo' }, 403, 'sem_vinculo'],
  ] as const)('recusa %j: status %i, registrada sem dado do cliente', async (resultado, status, outcome) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const d = deps(sessao(['organization:access']));
    d.confirmar.mockResolvedValue(resultado);

    const res = await criarRotasDaVerificacao(d).alterarVerificacao(post(URL_VERIFICACAO, { acao: 'confirmar', conversaId: CONVERSA, commandId: COMANDO, clienteId: CLIENTE }));

    expect(res.status).toBe(status);
    const evento = JSON.parse(String(warn.mock.calls[0][0]));
    expect(evento).toMatchObject({ message: 'sac.verificacao', acao: 'confirmar', outcome, correlationId: 'corr-teste-1', conversaId: CONVERSA });
    expect(JSON.stringify(evento)).not.toContain(CLIENTE);
  });

  it('revogar: desfeita ou já sem confirmação respondem 200; o banco fora, 503', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const d = deps(sessao(['organization:access']));
    const rotas = criarRotasDaVerificacao(d);

    expect(await (await rotas.alterarVerificacao(post(URL_VERIFICACAO, { acao: 'revogar', conversaId: CONVERSA }))).json()).toEqual({ success: true, revogada: true });
    d.revogar.mockResolvedValue({ _tag: 'SemProva' });
    expect(await (await rotas.alterarVerificacao(post(URL_VERIFICACAO, { acao: 'revogar', conversaId: CONVERSA }))).json()).toEqual({ success: true, revogada: false });
    d.revogar.mockRejectedValue(new VerificacaoIndisponivel());
    expect((await rotas.alterarVerificacao(post(URL_VERIFICACAO, { acao: 'revogar', conversaId: CONVERSA }))).status).toBe(503);
  });
});

describe('pedidos da conversa', () => {
  it('GET: com prova, só o contrato mínimo; a consulta é criada com o escopo da sessão e a conversa', async () => {
    const d = deps(sessao(['organization:access']));
    const res = await criarRotasDaVerificacao(d).listarPedidos(new Request(`${URL_PEDIDOS}?conversaId=${CONVERSA}&clienteId=${CLIENTE}`));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, versao: 1, pedidos: [umPedido] });
    expect(d.consultaDePedidos).toHaveBeenCalledWith(expect.objectContaining({ organizationId: ORG_A }), CONVERSA);
    expect(d.pedidos.listar).toHaveBeenCalledWith();
  });

  it.each([
    [{ _tag: 'SemProva', proximoPasso: 'encaminhar_para_humano' }, 409, 'sem_prova'],
    [{ _tag: 'Bloqueada', proximoPasso: 'encaminhar_para_humano' }, 429, 'bloqueada'],
    [{ _tag: 'NaoEncontrado' }, 404, 'nao_encontrado'],
    [{ _tag: 'ConversaNaoEncontrada' }, 404, 'conversa_nao_encontrada'],
  ] as const)('POST por número, %j: status %i e nenhum pedido na resposta', async (consulta, status, motivo) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const d = deps(sessao(['organization:access']), consulta);
    const res = await criarRotasDaVerificacao(d).localizarPedido(post(URL_PEDIDOS, { conversaId: CONVERSA, numero: '2001' }));
    const corpo = await res.json();

    expect(res.status).toBe(status);
    expect(corpo).toMatchObject({ success: false, motivo });
    expect(corpo).not.toHaveProperty('pedidos');
    expect(d.pedidos.localizar).toHaveBeenCalledWith('2001');
    const evento = JSON.parse(String(warn.mock.calls[0][0]));
    expect(evento).toMatchObject({ message: 'sac.consulta_de_pedido', outcome: motivo, conversaId: CONVERSA, correlationId: 'corr-teste-1' });
    expect(JSON.stringify(evento)).not.toContain('2001');
  });

  it('pedido alheio e pedido inexistente têm a mesma resposta, byte a byte', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const respostas = [];
    for (const numero of ['2001', '9999']) {
      const d = deps(sessao(['organization:access']), { _tag: 'NaoEncontrado' });
      respostas.push(await (await criarRotasDaVerificacao(d).localizarPedido(post(URL_PEDIDOS, { conversaId: CONVERSA, numero }))).text());
    }
    expect(respostas[0]).toBe(respostas[1]);
  });

  it.each([[''], ['   '], ['9'.repeat(41)], [1001], [undefined]])('número inválido %j: 400 sem consultar', async (numero) => {
    const d = deps(sessao(['organization:access']));
    const res = await criarRotasDaVerificacao(d).localizarPedido(post(URL_PEDIDOS, { conversaId: CONVERSA, numero }));
    expect(res.status).toBe(400);
    expect(d.consultaDePedidos).not.toHaveBeenCalled();
  });

  it('banco fora ou resposta fora do contrato: 503, nunca lista vazia', async () => {
    const d = deps(sessao(['organization:access']));
    vi.mocked(d.pedidos.listar).mockRejectedValue(new VerificacaoIndisponivel());
    const res = await criarRotasDaVerificacao(d).listarPedidos(new Request(`${URL_PEDIDOS}?conversaId=${CONVERSA}`));
    expect(res.status).toBe(503);
    expect(await res.json()).not.toHaveProperty('pedidos');
  });
});

describe('superfície das rotas', () => {
  it('cada rota exporta só GET e POST', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project-ref.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'public-key-12345678901234567890';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'server-key-12345678901234567890';
    for (const rota of [await import('./route'), await import('../pedidos/route')]) {
      expect(Object.keys(rota).filter((k) => /^(GET|POST|PUT|PATCH|DELETE)$/u.test(k)).sort()).toEqual(['GET', 'POST']);
    }
  });
});
