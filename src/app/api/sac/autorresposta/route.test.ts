import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GET, POST } from './route';

const { identidade, contexto, rpc } = vi.hoisted(() => ({
  identidade: vi.fn(),
  contexto: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ resolveAuthenticatedIdentity: identidade }));
vi.mock('@/lib/organizationAuthorization', () => ({ organizationContextStatus: () => 401 }));
vi.mock('@/lib/requestOrganizationContext', () => ({ resolveActiveRequestOrganizationContext: contexto }));
vi.mock('@/lib/supabaseServer', () => ({ supabaseServer: { rpc } }));

const actorId = '69c436f0-768a-4cff-b8c4-74ad5b17f0ed';
const organizationId = '7ffe98b2-0789-4c5c-975d-23246b2e13d8';
const comando = { ativa: false, versaoEsperada: 1, motivo: 'pausa operacional' };

function post(body: unknown, query = '') {
  return new Request('https://orbita.test/api/sac/autorresposta' + query, {
    method: 'POST', body: JSON.stringify(body),
  });
}

describe('administração da autorresposta SAC', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    contexto.mockResolvedValue({
      _tag: 'OrganizationContextResolved',
      context: { actorId, organizationId, capabilities: new Set(['organization:manage']) },
    });
  });

  it('deriva ator e organização da sessão e traduz CAS recusado em 409', async () => {
    rpc.mockResolvedValue({ data: 'conflito', error: null });
    expect((await POST(post(comando))).status).toBe(409);
    expect(rpc).toHaveBeenCalledWith('alterar_politica_autorresposta', {
      p_ator_id: actorId, p_organizacao_id: organizationId, p_ativa: false,
      p_versao: 1, p_motivo: 'pausa operacional',
    });
  });

  it('rejeita parâmetros de autoridade no corpo', async () => {
    expect((await POST(post({ ...comando, organizacaoId: actorId }))).status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('rejeita membro antes de usar o cliente privilegiado', async () => {
    contexto.mockResolvedValue({ _tag: 'OrganizationContextResolved', context: { capabilities: new Set() } });
    expect((await POST(post(comando))).status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('usa identidade global independente da organização e exige autorização do banco', async () => {
    identidade.mockResolvedValue({ _tag: 'IdentityVerified', user: { id: actorId } });
    rpc.mockResolvedValue({ data: null, error: { code: '42501' } });
    expect((await GET(new Request('https://orbita.test/api/sac/autorresposta?escopo=global'))).status).toBe(403);
    expect(rpc).toHaveBeenCalledWith('ler_politica_autorresposta', { p_ator_id: actorId, p_organizacao_id: null });
    expect(contexto).not.toHaveBeenCalled();
  });
});
