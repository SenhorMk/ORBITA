import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  scope: vi.fn(), capacidade: vi.fn(), selecionar: vi.fn(), consultar: vi.fn(),
  limite: vi.fn(), consultaLocal: vi.fn(),
}));
vi.mock('@/lib/requestOrganizationContext', () => ({ resolveVerifiedOrganizationScope: mocks.scope }));
vi.mock('@/lib/verifiedOrganizationScope', () => ({ escopoTemCapacidade: mocks.capacidade }));
vi.mock('@/lib/supabaseServer', () => ({ supabaseServer: {} }));
vi.mock('@/lib/rateLimitStore', () => ({ createSupabaseRateLimitStore: () => ({ consume: mocks.limite }) }));
vi.mock('@/services/assistenteAdministrativo/selecionarFerramenta', () => ({ selecionarFerramenta: mocks.selecionar }));
vi.mock('@/services/assistenteAdministrativo/consultarAssistenteOrbita', () => ({ consultarAssistente: mocks.consultar }));
vi.mock('@/repositories/leiturasDoAssistenteOrbita', () => ({ leiturasDoAssistente: mocks.consultaLocal }));
vi.mock('@/services/bling', () => ({ bling: {} }));

import { POST } from './route';

const orgA = '6cb72dee-39ef-4fa7-8bc6-6307f9f97b0b';
const orgB = '27ffc773-dc4a-45bb-ad99-f49d94da6e21';
const scope = { organizationId: orgA, actorId: 'ator', role: 'member' };
const req = (organizacaoEsperada = orgA, pergunta = 'Qual o saldo do SKU X?') =>
  new Request('http://localhost/api/assistente/orbita', {
    method: 'POST', body: JSON.stringify({ pergunta, organizacaoEsperada }),
  });

describe('autorização e limites do Assistente ORBITA', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('ORBITA_ASSISTENTE_ADMIN_ENABLED', 'true');
    mocks.scope.mockResolvedValue({ _tag: 'RequestScopeResolved', scope });
    mocks.capacidade.mockReturnValue(true);
    mocks.limite.mockResolvedValue({ _tag: 'RateLimitRecorded', allowed: true, count: 1, resetAt: Date.now() + 30_000 });
    mocks.selecionar.mockResolvedValue({ acao: 'consultar_estoque', referencia: 'X' });
    mocks.consultar.mockResolvedValue({ mensagem: 'Saldo local' });
  });
  afterEach(() => vi.unstubAllEnvs());

  it('usa exclusivamente o tenant da sessão verificada nas leituras', async () => {
    expect((await POST(req())).status).toBe(200);
    expect(mocks.consultaLocal).toHaveBeenCalledWith(expect.anything(), scope, expect.any(AbortSignal));
  });

  it('recusa tenant divergente, sessão sem capacidade e limite atingido sem chamar Groq', async () => {
    expect((await POST(req(orgB))).status).toBe(409);
    mocks.capacidade.mockReturnValueOnce(false);
    expect((await POST(req())).status).toBe(403);
    mocks.limite.mockResolvedValueOnce({ _tag: 'RateLimitRecorded', allowed: false, count: 9, resetAt: Date.now() + 30_000 });
    expect((await POST(req())).status).toBe(429);
    expect(mocks.selecionar).not.toHaveBeenCalled();
  });

  it('recusa documento e telefone antes da IA e respeita o desligamento', async () => {
    const resposta = await POST(req(orgA, 'Qual é o CPF do cliente?'));
    expect((await resposta.json()).mensagem).toContain('área de clientes');
    vi.stubEnv('ORBITA_ASSISTENTE_ADMIN_ENABLED', 'false');
    expect((await POST(req())).status).toBe(503);
    expect(mocks.selecionar).not.toHaveBeenCalled();
  });

  it('repassa a memória curta ao seletor, sem trocas com dados pessoais, e recusa histórico grande demais', async () => {
    const historico = [
      { pergunta: 'Qual o email do cliente do pedido 12?', resposta: 'Consulte dados pessoais na área de clientes.' },
      { pergunta: 'Quanto tem do tepi?', resposta: 'Tepi de Bambu tem 10 unidades disponíveis.' },
    ];
    const comHistorico = (lista: unknown[]) => new Request('http://localhost/api/assistente/orbita', {
      method: 'POST', body: JSON.stringify({ pergunta: 'E do cacau?', organizacaoEsperada: orgA, historico: lista }),
    });
    expect((await POST(comHistorico(historico))).status).toBe(200);
    expect(mocks.selecionar).toHaveBeenCalledWith('E do cacau?', expect.any(String), expect.any(AbortSignal), [historico[1]]);
    expect(mocks.consultar).toHaveBeenCalledWith(expect.anything(), 'E do cacau?', expect.any(String), expect.anything(), ['Quanto tem do tepi?']);
    expect((await POST(comHistorico(Array.from({ length: 7 }, () => historico[1])))).status).toBe(400);
  });

  it('propaga a recusa de autenticação sem acessar dados', async () => {
    mocks.scope.mockResolvedValueOnce({ _tag: 'RequestScopeDenied', response: Response.json({}, { status: 401 }) });
    expect((await POST(req())).status).toBe(401);
    expect(mocks.limite).not.toHaveBeenCalled();
    expect(mocks.consultaLocal).not.toHaveBeenCalled();
  });
});
