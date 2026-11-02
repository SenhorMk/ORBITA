import { describe, expect, it, vi } from 'vitest';

import { auditarAutorizacaoOAuth, auditarConexao } from './auditoriaDeConexao';

/**
 * PRE-008: o rastro da (re)ativação de uma conexão. O evento sai com o escopo
 * verificado e sem nada do cofre; no callback OAuth, sem sessão, o par
 * organização × ator é verificado de novo antes de auditar.
 */

const ORG_A = '22222222-2222-4222-8222-222222222222';
const ATOR = '70000000-0000-4000-8000-000000000001';
const CONEXAO = '11111111-1111-4111-8111-111111111111';

function supabaseFalso(membro: boolean) {
  const rpc = vi.fn().mockResolvedValue({ data: 'evento-1', error: null });
  const client = {
    rpc,
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({ data: membro ? { papel: 'owner' } : null, error: null }),
          }),
        }),
      }),
    }),
  };
  // SAFETY: duplo mínimo; só `rpc` e a consulta de membership são usadas.
  return { client: client as never, rpc };
}

const conexao = { provedor: 'bling', conexaoId: CONEXAO, status: 'conectado', correlationId: 'corr-1' } as const;

describe('auditoria da conexão de integração (PRE-008)', () => {
  it('grava o evento no escopo verificado, com metadata só de provedor e status', async () => {
    const supabase = supabaseFalso(true);

    await auditarConexao(supabase.client, { organizationId: ORG_A, actorId: ATOR } as never,
      'integration.connection_configured', { ...conexao, status: 'pendente' });

    expect(supabase.rpc).toHaveBeenCalledWith('registrar_evento_auditoria', expect.objectContaining({
      p_org_id: ORG_A,
      p_actor_id: ATOR,
      p_acao: 'integration.connection_configured',
      p_recurso: 'conexoes_integracao',
      p_recurso_id: CONEXAO,
      p_correlation_id: 'corr-1',
      p_metadata: { provedor: 'bling', status: 'pendente' },
    }));
  });

  it('callback OAuth: ator ainda membro → evento de autorização', async () => {
    const supabase = supabaseFalso(true);

    await auditarAutorizacaoOAuth(supabase.client, { organizationId: ORG_A, actorId: ATOR }, conexao);

    expect(supabase.rpc).toHaveBeenCalledWith('registrar_evento_auditoria',
      expect.objectContaining({ p_acao: 'integration.connection_authorized', p_actor_id: ATOR }));
  });

  it('callback OAuth: ator que saiu da organização (owner removido) não autoriza nada', async () => {
    const supabase = supabaseFalso(false);

    await expect(auditarAutorizacaoOAuth(supabase.client, { organizationId: ORG_A, actorId: ATOR }, conexao))
      .rejects.toThrow('OrganizationScopeDenied');
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it('a RPC recusando, a falha sobe (quem chama decide se bloqueia)', async () => {
    const supabase = supabaseFalso(true);
    supabase.rpc.mockResolvedValueOnce({ data: null, error: { message: 'anti-forjamento' } });

    await expect(auditarConexao(supabase.client, { organizationId: ORG_A, actorId: ATOR } as never,
      'integration.connection_authorized', conexao)).rejects.toThrow('anti-forjamento');
  });
});
