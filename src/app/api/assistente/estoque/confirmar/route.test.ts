import { beforeEach, expect, it, vi } from 'vitest';

const portas = vi.hoisted(() => ({ sessao: vi.fn(), capacidade: vi.fn(), confirmar: vi.fn() }));
vi.mock('@/lib/requestOrganizationContext', () => ({ resolveVerifiedOrganizationScope: portas.sessao }));
vi.mock('@/lib/verifiedOrganizationScope', () => ({ escopoTemCapacidade: portas.capacidade }));
vi.mock('@/services/assistenteAdministrativo/baixaDeDemonstracao', () => ({ confirmarBaixa: portas.confirmar }));
import { POST } from './route';

const chave = '11111111-1111-4111-8111-111111111111';
const escopo = { organizationId: 'org', actorId: 'gestor' };
const enviar = (dados: object) => POST(new Request('http://localhost/api/assistente/estoque/confirmar', {
  method: 'POST', body: JSON.stringify(dados),
}));

beforeEach(() => {
  vi.resetAllMocks();
  portas.sessao.mockResolvedValue({ _tag: 'RequestScopeResolved', scope: escopo });
  portas.capacidade.mockReturnValue(true);
  portas.confirmar.mockResolvedValue(Response.json({ estado: 'baixado' }));
});

it('exige permissão e configuração de demonstração mesmo com uma proposta', async () => {
  vi.stubEnv('ORBITA_BAIXA_DEMO_ENABLED', 'false');
  try {
    expect((await enviar({ chave })).status).toBe(403);
    vi.stubEnv('ORBITA_BAIXA_DEMO_ENABLED', 'true');
    portas.capacidade.mockReturnValue(false);
    expect((await enviar({ chave })).status).toBe(403);
    expect(portas.confirmar).not.toHaveBeenCalled();
  } finally { vi.unstubAllEnvs(); }
});

it('recusa parâmetros alterados e confirma com a mesma chave e escopo da sessão', async () => {
  vi.stubEnv('ORBITA_BAIXA_DEMO_ENABLED', 'true');
  try {
    expect((await enviar({ chave, quantidade: 99, produto: chave, organizacao: chave })).status).toBe(400);
    expect(portas.confirmar).not.toHaveBeenCalled();
    expect((await enviar({ chave })).status).toBe(200);
    expect(portas.capacidade).toHaveBeenCalledWith(escopo, 'organization:manage');
    expect(portas.confirmar).toHaveBeenCalledWith(escopo, chave);
  } finally { vi.unstubAllEnvs(); }
});
