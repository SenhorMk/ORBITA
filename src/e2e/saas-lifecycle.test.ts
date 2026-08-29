import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import {
  suspendOrganization,
  reactivateOrganization,
  scheduleOrganizationDeletion,
  assertOrganizationActive,
  OrganizationInactiveError,
} from '@/services/organizationLifecycleService';
import {
  enforceMemberLimit,
  enforceFeatureAccess,
  EntitlementLimitExceededError,
  FeatureNotIncludedError,
} from '@/services/entitlementsService';
import {
  generateBlingIdempotencyKey,
  blingInboxService,
} from '@/services/blingInboxService';
import {
  generateChatwootIdempotencyKey,
  chatwootInboxService,
} from '@/services/chatwootInboxService';
import {
  outboxService,
  classifyError,
} from '@/services/outboxService';
import {
  createOrgInvite,
  acceptOrgInvite,
  revokeOrgMember,
} from '@/lib/invitationService';
import {
  resolveActiveOrganization,
  createOrganizationAtomic,
  resolveTenantOrgId,
} from '@/lib/organizationContext';

describe('ORBITA End-to-End SaaS Lifecycle & Production Rehearsal (Ticket 44)', () => {
  const testOrgId = '95000000-0000-4000-8000-000000000001';
  const testUserId = '95000000-0000-4000-8000-000000000002';
  const testScope = {
    organizationId: testOrgId,
    actorId: testUserId,
    role: 'owner',
  } as unknown as VerifiedOrganizationScope;

  beforeAll(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://orbita-staging.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key-staging-mock-123456789';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-staging-mock-123456789';
    process.env.BLING_WEBHOOK_SECRET = 'bling-e2e-webhook-secret-999';
    process.env.CHATWOOT_WEBHOOK_SECRET = 'chatwoot-e2e-webhook-secret-999';
    process.env.INTEGRATION_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  });

  describe('1. Autenticação, Registro e Resolução de Tenancy', () => {
    it('valida payload de registro com regras de validação estritas', async () => {
      const { POST: registerHandler } = await import('@/app/api/auth/register/route');
      const badReq = new Request('https://orbita.test/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({ email: 'owner@saas.test' }),
      });
      const res = await registerHandler(badReq);
      expect(res.status).toBe(400);
    });

    // Este caso cobre apenas o mapeamento de parâmetros da RPC. Ele NÃO cobre
    // qual cliente Supabase executa a chamada — foi exatamente essa lacuna que
    // deixou o defeito do Ticket 26 (`auth.uid()` NULL sob service_role) chegar
    // à produção com a suíte verde. A identidade do chamador é coberta em
    // `src/app/api/organizacoes/route.test.ts`; não trate este teste como
    // substituto dele.
    it('cria organização atomicamente via RPC (apenas parâmetros; identidade do chamador é coberta na rota)', async () => {
      const rpcMock = vi.fn().mockResolvedValue({ data: testOrgId, error: null });
      const fakeClient = { rpc: rpcMock } as unknown as SupabaseClient;

      const created = await createOrganizationAtomic(fakeClient, {
        nome: 'Empresa Matriz E2E',
        slug: 'empresa-matriz-e2e',
      });

      expect(created.id).toBe(testOrgId);
      expect(rpcMock).toHaveBeenCalledWith('criar_organizacao_atomica', {
        p_nome: 'Empresa Matriz E2E',
        p_slug: 'empresa-matriz-e2e',
      });
    });

    it('resolve a organização ativa a partir do cookie de preferência com fallback seguro', async () => {
      const mockMemberData = {
        papel: 'admin',
        organizacoes: {
          id: testOrgId,
          nome: 'Empresa Principal',
          slug: 'empresa-principal',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      };

      const selectMock = {
        eq: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({
          data: mockMemberData,
          error: null,
        }),
      };

      const mockSupabase = {
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue(selectMock),
        }),
      } as unknown as SupabaseClient;

      const active = await resolveActiveOrganization(mockSupabase, testUserId, testOrgId);
      expect(active).not.toBeNull();
      expect(active?.organizacao.id).toBe(testOrgId);
      expect(active?.papel).toBe('admin');
    });

    it('resolve o ID da organização para um tenant verificado', async () => {
      const mockSupabase = {
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              order: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({
                    data: { organizacao_id: testOrgId },
                    error: null,
                  }),
                }),
              }),
            }),
          }),
        }),
      } as unknown as SupabaseClient;

      const resolvedOrg = await resolveTenantOrgId(mockSupabase, testUserId);
      expect(resolvedOrg).toBe(testOrgId);
    });
  });

  describe('2. Convites e RBAC Multi-tenant', () => {
    it('cria convite para novo membro respeitando limite do plano', async () => {
      const rpcMock = vi.fn().mockImplementation((fn: string) => {
        if (fn === 'criar_convite_organizacao') {
          return Promise.resolve({ data: 'invite-uuid-1234', error: null });
        }
        if (fn === 'obter_entitlements_organizacao') {
          return Promise.resolve({
            data: {
              organizacao_id: testOrgId,
              plano_id: 'plan-pro-id',
              plano_nome: 'Pro',
              plano_slug: 'pro',
              status: 'active',
              limite_membros: 10,
              limite_conexoes_bling: 5,
              limite_conexoes_chatwoot: 5,
              recursos: { auditoria: true },
              periodo_inicio: '2026-01-01',
            },
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      });

      const fakeClient = {
        rpc: rpcMock,
        from: vi.fn((table: string) => {
          if (table === 'organizacoes') {
            return {
              select: () => ({
                eq: () => ({
                  single: async () => ({
                    data: {
                      status: 'active',
                      suspenso_em: null,
                      motivo_suspensao: null,
                      exclusao_agendada_para: null,
                      updated_at: '2026-01-01T00:00:00.000Z',
                    },
                    error: null,
                  }),
                }),
              }),
            };
          }
          if (table === 'membros_organizacao') {
            return { select: () => ({ eq: async () => ({ count: 2, error: null }) }) };
          }
          if (table === 'conexoes_integracao') {
            return { select: () => ({ eq: () => ({ eq: () => ({ eq: async () => ({ count: 0, error: null }) }) }) }) };
          }
          throw new Error(`tabela inesperada no teste e2e: ${table}`);
        }),
      } as unknown as SupabaseClient;

      const result = await createOrgInvite({ privileged: fakeClient, actor: fakeClient }, testScope, {
        email: 'collaborator@empresa.test',
        papel: 'member',
      });

      expect(result.id).toBe('invite-uuid-1234');
      expect(result.token).toBeDefined();
    });

    it('aceita convite com token criptográfico válido', async () => {
      const rpcMock = vi.fn().mockResolvedValue({ data: testOrgId, error: null });
      const fakeClient = { rpc: rpcMock } as unknown as SupabaseClient;

      const result = await acceptOrgInvite(fakeClient, '0123456789abcdef0123456789abcdef');
      expect(result.organizacaoId).toBe(testOrgId);
    });

    it('revoga membro de organização via RPC', async () => {
      const rpcMock = vi.fn().mockResolvedValue({ data: true, error: null });
      const fakeClient = { rpc: rpcMock } as unknown as SupabaseClient;

      const revoked = await revokeOrgMember(fakeClient, testOrgId, 'user-to-remove-123');
      expect(revoked).toBe(true);
    });
  });

  describe('3. Ciclo de Vida de Assinatura, Planos e Entitlements', () => {
    it('bloqueia inclusão de membros quando o limite do plano é atingido', async () => {
      const rpcMock = vi.fn().mockResolvedValue({
        data: {
          organizacao_id: testOrgId,
          plano_id: 'plan-starter-id',
          plano_nome: 'Starter',
          plano_slug: 'starter',
          status: 'active',
          limite_membros: 2,
          limite_conexoes_bling: 1,
          limite_conexoes_chatwoot: 1,
          recursos: {},
          periodo_inicio: '2026-01-01',
        },
        error: null,
      });

      const fakeClient = {
        rpc: rpcMock,
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ count: 2, error: null }),
          }),
        }),
      } as unknown as SupabaseClient;

      await expect(enforceMemberLimit(fakeClient, testOrgId)).rejects.toThrow(EntitlementLimitExceededError);
    });

    it('valida acesso a recursos booleanos do plano e bloqueia recursos inexistentes', async () => {
      const rpcMock = vi.fn().mockResolvedValue({
        data: {
          organizacao_id: testOrgId,
          plano_id: 'plan-starter-id',
          plano_nome: 'Starter',
          plano_slug: 'starter',
          status: 'active',
          limite_membros: 5,
          limite_conexoes_bling: 1,
          limite_conexoes_chatwoot: 1,
          recursos: { relatorios_basicos: true, auditoria_avancada: false },
          periodo_inicio: '2026-01-01',
        },
        error: null,
      });

      const fakeClient = { rpc: rpcMock } as unknown as SupabaseClient;

      await expect(enforceFeatureAccess(fakeClient, testOrgId, 'auditoria_avancada')).rejects.toThrow(FeatureNotIncludedError);
    });
  });

  describe('4. Integrações Resilientes e Webhooks Seguros (Bling & Chatwoot)', () => {
    it('gera chave determinística de idempotência para o Bling ERP v3', () => {
      const key1 = generateBlingIdempotencyKey({ event: 'pedidos.atualizado', id: '12345' });
      const key2 = generateBlingIdempotencyKey({ event: 'pedidos.atualizado', id: '12345' });
      expect(key1).toBe(key2);
      expect(key1).toBe('pedidos.atualizado_12345');
    });

    it('registra evento no Inbox do Bling com detecção de duplicata', async () => {
      const rpcMock = vi.fn().mockResolvedValue({
        data: [{ evento_id: 'inbox-evt-1', status: 'received', is_duplicate: false, cached_response: null }],
        error: null,
      });
      const fakeClient = { rpc: rpcMock } as unknown as SupabaseClient;

      const result = await blingInboxService.registerEvent(fakeClient, testScope, {
        idempotencyKey: 'bling_order_9999',
        eventType: 'pedidos.criado',
        payload: { id: 9999, valor: 150.0 },
      });

      expect(result.eventoId).toBe('inbox-evt-1');
      expect(result.isDuplicate).toBe(false);
    });

    it('gera chave determinística e registra evento no Inbox do Chatwoot', async () => {
      const key = generateChatwootIdempotencyKey({ event: 'message_created', id: '456', conversation: { id: 789 } });
      expect(key).toBe('event_message_created_msg_456_conv_789');

      const rpcMock = vi.fn().mockResolvedValue({
        data: [{ evento_id: 'cw-inbox-evt-2', status: 'received', is_duplicate: false, cached_response: null }],
        error: null,
      });
      const fakeClient = { rpc: rpcMock } as unknown as SupabaseClient;

      const result = await chatwootInboxService.registerEvent(fakeClient, testScope, {
        idempotencyKey: key,
        eventType: 'message_created',
        payload: { content: 'Olá ORBITA' },
      });

      expect(result.eventoId).toBe('cw-inbox-evt-2');
      expect(result.isDuplicate).toBe(false);
    });

    it('enfileira mensagens no Outbox e classifica erros de integração (transitórios vs permanentes)', async () => {
      const rpcMock = vi.fn().mockResolvedValue({
        data: [{ evento_id: 'outbox-1', status: 'pending', is_duplicate: false }],
        error: null,
      });
      const fakeClient = { rpc: rpcMock } as unknown as SupabaseClient;

      const result = await outboxService.enqueue(fakeClient, testScope, {
        idempotencyKey: 'outbox_msg_10',
        destination: 'chatwoot',
        eventType: 'chatwoot.send_message',
        payload: { conversation_id: 10, content: 'Resposta E2E' },
      });

      expect(result.eventoId).toBe('outbox-1');

      // Classificação de erros
      expect(classifyError(new Error('HTTP 429 Too Many Requests')).category).toBe('rate_limit');
      expect(classifyError(new Error('HTTP 503 Service Unavailable')).category).toBe('transient');
      expect(classifyError(new Error('HTTP 401 Unauthorized invalid_grant')).category).toBe('auth_expired');
      expect(classifyError(new Error('HTTP 400 Bad Request')).category).toBe('permanent');
    });
  });

  describe('5. Suspensão, Reativação e Isolamento de Organização', () => {
    it('bloqueia operações em organizações suspensas (fail-closed)', async () => {
      const fromMock = vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: {
                status: 'suspended',
                suspenso_em: new Date().toISOString(),
                motivo_suspensao: 'Inadimplência',
                exclusao_agendada_para: null,
                encerrado_em: null,
              },
              error: null,
            }),
          }),
        }),
      });
      const fakeClient = { from: fromMock } as unknown as SupabaseClient;

      await expect(assertOrganizationActive(fakeClient, testOrgId)).rejects.toThrow(OrganizationInactiveError);
    });

    it('suspende e reativa organizações com auditoria de autor', async () => {
      const rpcMock = vi.fn().mockResolvedValue({ data: null, error: null });
      const fakeClient = { rpc: rpcMock } as unknown as SupabaseClient;

      await suspendOrganization(fakeClient, testScope, 'Falta de pagamento');
      expect(rpcMock).toHaveBeenCalledWith('suspender_organizacao', {
        p_org_id: testOrgId,
        p_motivo: 'Falta de pagamento',
        p_autor_id: testUserId,
      });

      await reactivateOrganization(fakeClient, testScope, 'Fatura quitada');
      expect(rpcMock).toHaveBeenCalledWith('reativar_organizacao', {
        p_org_id: testOrgId,
        p_motivo: 'Fatura quitada',
        p_autor_id: testUserId,
      });
    });

    it('agenda encerramento de organização respeitando prazo regulatório de retenção', async () => {
      const rpcMock = vi.fn().mockResolvedValue({ data: '2026-09-22T12:00:00Z', error: null });
      const fakeClient = { rpc: rpcMock } as unknown as SupabaseClient;

      const scheduled = await scheduleOrganizationDeletion(fakeClient, testScope, 'Solicitação do cliente', 30);
      expect(scheduled).toBe('2026-09-22T12:00:00Z');
    });
  });
});
