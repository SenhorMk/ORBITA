import { describe, it, expect, vi } from 'vitest';
import {
  suspendOrganization,
  reactivateOrganization,
  scheduleOrganizationDeletion,
  cancelOrganizationDeletion,
  executeOrganizationPurge,
  assertOrganizationActive,
  OrganizationInactiveError,
} from './organizationLifecycleService';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';

describe('organizationLifecycleService', () => {
  const mockOrgId = 'org-1234-5678-9012';
  const mockScope = {
    organizationId: mockOrgId,
    actorId: 'user-owner-1',
    role: 'owner',
  } as unknown as VerifiedOrganizationScope;

  it('deve suspender a organizacao chamando a RPC suspender_organizacao', async () => {
    const rpcMock = vi.fn().mockResolvedValue({ data: null, error: null });
    const fakeClient = { rpc: rpcMock } as unknown as SupabaseClient;

    await suspendOrganization(fakeClient, mockScope, 'Inadimplencia Stripe');

    expect(rpcMock).toHaveBeenCalledWith('suspender_organizacao', {
      p_org_id: mockOrgId,
      p_motivo: 'Inadimplencia Stripe',
      p_autor_id: 'user-owner-1',
    });
  });

  it('deve lançar erro quando a RPC de suspensao falhar', async () => {
    const rpcMock = vi.fn().mockResolvedValue({ data: null, error: { message: 'Acesso negado' } });
    const fakeClient = { rpc: rpcMock } as unknown as SupabaseClient;

    await expect(
      suspendOrganization(fakeClient, mockScope, 'Inadimplencia'),
    ).rejects.toThrow('Falha ao executar suspender_organizacao: Acesso negado');
  });

  it('deve reativar a organizacao chamando a RPC reativar_organizacao', async () => {
    const rpcMock = vi.fn().mockResolvedValue({ data: null, error: null });
    const fakeClient = { rpc: rpcMock } as unknown as SupabaseClient;

    await reactivateOrganization(fakeClient, mockScope, 'Pagamento regularizado');

    expect(rpcMock).toHaveBeenCalledWith('reativar_organizacao', {
      p_org_id: mockOrgId,
      p_motivo: 'Pagamento regularizado',
      p_autor_id: 'user-owner-1',
    });
  });

  it('deve agendar encerramento retornando a data agendada', async () => {
    const scheduledDate = '2026-09-20T12:00:00Z';
    const rpcMock = vi.fn().mockResolvedValue({ data: scheduledDate, error: null });
    const fakeClient = { rpc: rpcMock } as unknown as SupabaseClient;

    const result = await scheduleOrganizationDeletion(fakeClient, mockScope, 'Encerramento de negocio', 30);

    expect(result).toBe(scheduledDate);
    expect(rpcMock).toHaveBeenCalledWith('agendar_encerramento_organizacao', {
      p_org_id: mockOrgId,
      p_motivo: 'Encerramento de negocio',
      p_dias_retencao: 30,
      p_autor_id: 'user-owner-1',
    });
  });

  it('deve cancelar agendamento de encerramento', async () => {
    const rpcMock = vi.fn().mockResolvedValue({ data: null, error: null });
    const fakeClient = { rpc: rpcMock } as unknown as SupabaseClient;

    await cancelOrganizationDeletion(fakeClient, mockScope);

    expect(rpcMock).toHaveBeenCalledWith('cancelar_agendamento_encerramento', {
      p_org_id: mockOrgId,
      p_autor_id: 'user-owner-1',
    });
  });

  it('deve executar o encerramento definitivo via service_role', async () => {
    const rpcMock = vi.fn().mockResolvedValue({ data: null, error: null });
    const fakeClient = { rpc: rpcMock } as unknown as SupabaseClient;

    await executeOrganizationPurge(fakeClient, mockOrgId, 'Fim do grace period');

    expect(rpcMock).toHaveBeenCalledWith('executar_encerramento_definitivo', {
      p_org_id: mockOrgId,
      p_motivo: 'Fim do grace period',
    });
  });

  it('assertOrganizationActive deve retornar dados quando status for active', async () => {
    const singleMock = vi.fn().mockResolvedValue({
      data: {
        status: 'active',
        suspenso_em: null,
        motivo_suspensao: null,
        exclusao_agendada_para: null,
        encerrado_em: null,
      },
      error: null,
    });
    const eqMock = vi.fn().mockReturnValue({ single: singleMock });
    const selectMock = vi.fn().mockReturnValue({ eq: eqMock });
    const fromMock = vi.fn().mockReturnValue({ select: selectMock });
    const fakeClient = { from: fromMock } as unknown as SupabaseClient;

    const state = await assertOrganizationActive(fakeClient, mockOrgId);

    expect(state.status).toBe('active');
    expect(state.suspensoEm).toBeNull();
  });

  it('assertOrganizationActive deve lançar OrganizationInactiveError se status for suspended', async () => {
    const singleMock = vi.fn().mockResolvedValue({
      data: {
        status: 'suspended',
        suspenso_em: '2026-08-20T10:00:00Z',
        motivo_suspensao: 'Inadimplencia',
        exclusao_agendada_para: null,
        encerrado_em: null,
      },
      error: null,
    });
    const eqMock = vi.fn().mockReturnValue({ single: singleMock });
    const selectMock = vi.fn().mockReturnValue({ eq: eqMock });
    const fromMock = vi.fn().mockReturnValue({ select: selectMock });
    const fakeClient = { from: fromMock } as unknown as SupabaseClient;

    await expect(assertOrganizationActive(fakeClient, mockOrgId)).rejects.toThrow(OrganizationInactiveError);
  });
});
