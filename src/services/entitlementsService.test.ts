/**
 * entitlementsService.test.ts
 * Ticket 37: Testes unitários e de integração do serviço de entitlements e limites.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  getOrganizationEntitlements,
  enforceMemberLimit,
  enforceIntegrationLimit,
  enforceFeatureAccess,
  updateOrganizationPlan,
  EntitlementLimitExceededError,
  FeatureNotIncludedError,
} from './entitlementsService';

const ORG_ID = '99900000-0000-4000-8000-000000000001';
const STARTER_PLAN_ID = '11111111-0000-4000-8000-000000000001';
const PRO_PLAN_ID = '22222222-0000-4000-8000-000000000002';

describe('Ticket 37: entitlementsService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getOrganizationEntitlements', () => {
    it('retorna os entitlements retornados pela RPC com sucesso', async () => {
      const mockSupabase = {
        rpc: vi.fn().mockResolvedValueOnce({
          data: {
            organizacao_id: ORG_ID,
            plano_id: PRO_PLAN_ID,
            plano_nome: 'Pro',
            plano_slug: 'pro',
            status: 'active',
            limite_membros: 10,
            limite_conexoes_bling: 3,
            limite_conexoes_chatwoot: 3,
            recursos: { export_relatorios: true, suporte_prioritario: true },
            periodo_inicio: '2026-08-01T00:00:00.000Z',
            periodo_fim: '2026-09-01T00:00:00.000Z',
          },
          error: null,
        }),
      } as unknown as SupabaseClient;

      const result = await getOrganizationEntitlements(mockSupabase, ORG_ID);

      expect(result.plano_slug).toBe('pro');
      expect(result.limite_membros).toBe(10);
      expect(result.recursos.export_relatorios).toBe(true);
      expect(mockSupabase.rpc).toHaveBeenCalledWith('obter_entitlements_organizacao', {
        p_org_id: ORG_ID,
      });
    });

    it('aplica fallback defensivo para starter trial em caso de erro da RPC', async () => {
      const mockSupabase = {
        rpc: vi.fn().mockResolvedValueOnce({
          data: null,
          error: { message: 'Database connection error' },
        }),
      } as unknown as SupabaseClient;

      const result = await getOrganizationEntitlements(mockSupabase, ORG_ID);

      expect(result.plano_slug).toBe('starter');
      expect(result.status).toBe('trial');
      expect(result.limite_membros).toBe(3);
      expect(result.recursos.export_relatorios).toBe(false);
    });
  });

  describe('enforceMemberLimit', () => {
    it('permite adição quando a contagem atual é menor que o limite', async () => {
      const mockSupabase = {
        rpc: vi.fn().mockResolvedValueOnce({
          data: {
            organizacao_id: ORG_ID,
            plano_id: STARTER_PLAN_ID,
            plano_nome: 'Starter',
            plano_slug: 'starter',
            status: 'active',
            limite_membros: 3,
            limite_conexoes_bling: 1,
            limite_conexoes_chatwoot: 1,
            recursos: {},
            periodo_inicio: '2026-08-01T00:00:00.000Z',
          },
          error: null,
        }),
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValueOnce({ count: 2, error: null }),
          }),
        }),
      } as unknown as SupabaseClient;

      await expect(enforceMemberLimit(mockSupabase, ORG_ID)).resolves.not.toThrow();
    });

    it('lança EntitlementLimitExceededError quando o limite de membros é atingido', async () => {
      const mockSupabase = {
        rpc: vi.fn().mockResolvedValueOnce({
          data: {
            organizacao_id: ORG_ID,
            plano_id: STARTER_PLAN_ID,
            plano_nome: 'Starter',
            plano_slug: 'starter',
            status: 'active',
            limite_membros: 3,
            limite_conexoes_bling: 1,
            limite_conexoes_chatwoot: 1,
            recursos: {},
            periodo_inicio: '2026-08-01T00:00:00.000Z',
          },
          error: null,
        }),
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValueOnce({ count: 3, error: null }),
          }),
        }),
      } as unknown as SupabaseClient;

      await expect(enforceMemberLimit(mockSupabase, ORG_ID)).rejects.toThrow(
        EntitlementLimitExceededError,
      );
    });
  });

  describe('enforceIntegrationLimit', () => {
    it('permite conexão Bling quando está dentro do limite do plano', async () => {
      const mockSupabase = {
        rpc: vi.fn().mockResolvedValueOnce({
          data: {
            organizacao_id: ORG_ID,
            plano_id: STARTER_PLAN_ID,
            plano_nome: 'Starter',
            plano_slug: 'starter',
            status: 'active',
            limite_membros: 3,
            limite_conexoes_bling: 1,
            limite_conexoes_chatwoot: 1,
            recursos: {},
            periodo_inicio: '2026-08-01T00:00:00.000Z',
          },
          error: null,
        }),
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockResolvedValueOnce({ count: 0, error: null }),
              }),
            }),
          }),
        }),
      } as unknown as SupabaseClient;

      await expect(
        enforceIntegrationLimit(mockSupabase, ORG_ID, 'bling'),
      ).resolves.not.toThrow();
    });

    it('bloqueia nova conexão Bling quando limite atingido', async () => {
      const mockSupabase = {
        rpc: vi.fn().mockResolvedValueOnce({
          data: {
            organizacao_id: ORG_ID,
            plano_id: STARTER_PLAN_ID,
            plano_nome: 'Starter',
            plano_slug: 'starter',
            status: 'active',
            limite_membros: 3,
            limite_conexoes_bling: 1,
            limite_conexoes_chatwoot: 1,
            recursos: {},
            periodo_inicio: '2026-08-01T00:00:00.000Z',
          },
          error: null,
        }),
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockResolvedValueOnce({ count: 1, error: null }),
              }),
            }),
          }),
        }),
      } as unknown as SupabaseClient;

      await expect(
        enforceIntegrationLimit(mockSupabase, ORG_ID, 'bling'),
      ).rejects.toThrow(EntitlementLimitExceededError);
    });
  });

  describe('enforceFeatureAccess', () => {
    it('permite acesso a funcionalidade inclusa no plano', async () => {
      const mockSupabase = {
        rpc: vi.fn().mockResolvedValueOnce({
          data: {
            organizacao_id: ORG_ID,
            plano_id: PRO_PLAN_ID,
            plano_nome: 'Pro',
            plano_slug: 'pro',
            status: 'active',
            limite_membros: 10,
            limite_conexoes_bling: 3,
            limite_conexoes_chatwoot: 3,
            recursos: { export_relatorios: true },
            periodo_inicio: '2026-08-01T00:00:00.000Z',
          },
          error: null,
        }),
      } as unknown as SupabaseClient;

      await expect(
        enforceFeatureAccess(mockSupabase, ORG_ID, 'export_relatorios'),
      ).resolves.not.toThrow();
    });

    it('bloqueia funcionalidade com FeatureNotIncludedError quando não inclusa', async () => {
      const mockSupabase = {
        rpc: vi.fn().mockResolvedValueOnce({
          data: {
            organizacao_id: ORG_ID,
            plano_id: STARTER_PLAN_ID,
            plano_nome: 'Starter',
            plano_slug: 'starter',
            status: 'active',
            limite_membros: 3,
            limite_conexoes_bling: 1,
            limite_conexoes_chatwoot: 1,
            recursos: { export_relatorios: false },
            periodo_inicio: '2026-08-01T00:00:00.000Z',
          },
          error: null,
        }),
      } as unknown as SupabaseClient;

      await expect(
        enforceFeatureAccess(mockSupabase, ORG_ID, 'export_relatorios'),
      ).rejects.toThrow(FeatureNotIncludedError);
    });
  });

  describe('updateOrganizationPlan', () => {
    it('atualiza o plano para Pro e insere evento de upgrade no histórico auditável', async () => {
      const selectPlanMock = vi.fn().mockImplementation(() => ({
        eq: vi.fn().mockImplementation(() => ({
          single: vi.fn().mockResolvedValue({
            data: { id: PRO_PLAN_ID, nome: 'Pro', slug: 'pro' },
            error: null,
          }),
          maybeSingle: vi.fn().mockResolvedValue({
            data: { slug: 'starter' },
            error: null,
          }),
        })),
      }));

      const selectCurrentSubMock = vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValueOnce({
            data: { plano_id: STARTER_PLAN_ID, status: 'active' },
            error: null,
          }),
        }),
      });

      const upsertSubMock = vi.fn().mockResolvedValueOnce({ error: null });
      const insertHistoryMock = vi.fn().mockResolvedValueOnce({ error: null });

      const mockSupabase = {
        from: vi.fn((table: string) => {
          if (table === 'planos') return { select: selectPlanMock };
          if (table === 'assinaturas_organizacao') {
            return { select: selectCurrentSubMock, upsert: upsertSubMock };
          }
          if (table === 'historico_entitlements') {
            return { insert: insertHistoryMock };
          }
          return {};
        }),
      } as unknown as SupabaseClient;

      await updateOrganizationPlan(mockSupabase, ORG_ID, 'pro', 'Upgrade para Pro');

      expect(upsertSubMock).toHaveBeenCalledWith(
        expect.objectContaining({
          organizacao_id: ORG_ID,
          plano_id: PRO_PLAN_ID,
          status: 'active',
        }),
        { onConflict: 'organizacao_id' },
      );

      expect(insertHistoryMock).toHaveBeenCalledWith(
        expect.objectContaining({
          organizacao_id: ORG_ID,
          evento: 'upgrade_plano',
          plano_anterior_id: STARTER_PLAN_ID,
          novo_plano_id: PRO_PLAN_ID,
          motivo: 'Upgrade para Pro',
        }),
      );
    });

    it('atualiza o plano para Starter e insere evento de downgrade no histórico auditável', async () => {
      const selectPlanMock = vi.fn().mockImplementation(() => ({
        eq: vi.fn().mockImplementation(() => ({
          single: vi.fn().mockResolvedValue({
            data: { id: STARTER_PLAN_ID, nome: 'Starter', slug: 'starter' },
            error: null,
          }),
          maybeSingle: vi.fn().mockResolvedValue({
            data: { slug: 'pro' },
            error: null,
          }),
        })),
      }));

      const selectCurrentSubMock = vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValueOnce({
            data: { plano_id: PRO_PLAN_ID, status: 'active' },
            error: null,
          }),
        }),
      });

      const upsertSubMock = vi.fn().mockResolvedValueOnce({ error: null });
      const insertHistoryMock = vi.fn().mockResolvedValueOnce({ error: null });

      const mockSupabase = {
        from: vi.fn((table: string) => {
          if (table === 'planos') return { select: selectPlanMock };
          if (table === 'assinaturas_organizacao') {
            return { select: selectCurrentSubMock, upsert: upsertSubMock };
          }
          if (table === 'historico_entitlements') {
            return { insert: insertHistoryMock };
          }
          return {};
        }),
      } as unknown as SupabaseClient;

      await updateOrganizationPlan(mockSupabase, ORG_ID, 'starter', 'Downgrade para Starter');

      expect(insertHistoryMock).toHaveBeenCalledWith(
        expect.objectContaining({
          organizacao_id: ORG_ID,
          evento: 'downgrade_plano',
          plano_anterior_id: PRO_PLAN_ID,
          novo_plano_id: STARTER_PLAN_ID,
          motivo: 'Downgrade para Starter',
        }),
      );
    });
  });
});
