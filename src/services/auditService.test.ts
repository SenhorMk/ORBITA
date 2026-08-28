import { describe, it, expect, vi } from 'vitest';
import { recordAuditEvent, listAuditEvents, recordSystemAuditEvent } from './auditService';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';

describe('auditService', () => {
  const scope = {
    organizationId: 'org-123',
    actorId: 'user-456',
    role: 'owner',
  } as unknown as VerifiedOrganizationScope;
  it('recordAuditEvent sanitiza segredos no metadata e chama RPC registrar_evento_auditoria', async () => {
    const rpcMock = vi.fn().mockResolvedValue({ data: 'audit-event-uuid-123', error: null });
    const fakeClient = { rpc: rpcMock } as unknown as SupabaseClient;

    const eventId = await recordAuditEvent(fakeClient, scope, {
      acao: 'auth.api_key_created',
      recurso: 'api_key',
      recursoId: 'key-789',
      correlationId: 'corr_test_999',
      ipAddress: '192.168.1.1',
      userAgent: 'JestTestRunner',
      metadata: {
        rawSecretToken: 'sk_secret_1234567890',
        name: 'Production Key',
      },
    });

    expect(eventId).toBe('audit-event-uuid-123');
    expect(rpcMock).toHaveBeenCalledWith('registrar_evento_auditoria', {
      p_org_id: 'org-123',
      p_actor_id: 'user-456',
      p_acao: 'auth.api_key_created',
      p_recurso: 'api_key',
      p_recurso_id: 'key-789',
      p_correlation_id: 'corr_test_999',
      p_ip_address: '192.168.1.1',
      p_user_agent: 'JestTestRunner',
      p_metadata: {
        rawSecretToken: '[REDACTED]',
        name: 'Production Key',
      },
    });
  });

  it('recordAuditEvent rejeita acao fora do catálogo versionado sem chamar a RPC', async () => {
    const rpcMock = vi.fn().mockResolvedValue({ data: 'should-not-be-called', error: null });
    const fakeClient = { rpc: rpcMock } as unknown as SupabaseClient;

    await expect(
      recordAuditEvent(fakeClient, scope, {
        acao: 'evento.forjado.nao.catalogado',
        recurso: 'x',
      }),
    ).rejects.toThrow(/catálogo/i);

    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('recordAuditEvent rejeita metadata com campo explicitamente proibido do evento', async () => {
    const rpcMock = vi.fn().mockResolvedValue({ data: 'id', error: null });
    const fakeClient = { rpc: rpcMock } as unknown as SupabaseClient;

    await expect(
      recordAuditEvent(fakeClient, scope, {
        acao: 'billing.owner_changed',
        recurso: 'organization',
        metadata: { cardNumber: '4111111111111111' },
      }),
    ).rejects.toThrow(/proibido/i);

    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('recordSystemAuditEvent registra evento de sistema sem ator humano via identidade verificada', async () => {
    const rpcMock = vi.fn().mockResolvedValue({ data: 'sys-event-1', error: null });
    const fakeClient = { rpc: rpcMock } as unknown as SupabaseClient;

    const eventId = await recordSystemAuditEvent(fakeClient, {
      source: 'webhook_processor',
      organizationId: 'org-abc',
      acao: 'webhook.signature_invalid',
      recurso: 'bling_webhook',
      metadata: {},
    });

    expect(eventId).toBe('sys-event-1');
    expect(rpcMock).toHaveBeenCalledWith(
      'registrar_evento_auditoria',
      expect.objectContaining({
        p_org_id: 'org-abc',
        p_actor_id: null,
        p_acao: 'webhook.signature_invalid',
      }),
    );
  });

  it('recordSystemAuditEvent rejeita acao fora do catálogo', async () => {
    const rpcMock = vi.fn();
    const fakeClient = { rpc: rpcMock } as unknown as SupabaseClient;

    await expect(
      recordSystemAuditEvent(fakeClient, {
        source: 'worker',
        organizationId: 'org-abc',
        acao: 'evento.inexistente',
        recurso: 'x',
      }),
    ).rejects.toThrow(/catálogo/i);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('listAuditEvents busca eventos com range de paginacao', async () => {
    const rangeMock = vi.fn().mockResolvedValue({
      data: [
        {
          id: 'event-1',
          organizacao_id: 'org-123',
          actor_id: 'user-1',
          acao: 'org.member_added',
          recurso: 'member',
          recurso_id: 'user-2',
          correlation_id: 'corr_1',
          ip_address: '127.0.0.1',
          user_agent: 'browser',
          metadata: {},
          created_at: '2026-08-20T19:00:00Z',
        },
      ],
      count: 1,
      error: null,
    });
    const orderMock = vi.fn().mockReturnValue({ range: rangeMock });
    const eqMock = vi.fn().mockReturnValue({ order: orderMock });
    const selectMock = vi.fn().mockReturnValue({ eq: eqMock });
    const fromMock = vi.fn().mockReturnValue({ select: selectMock });
    const fakeClient = { from: fromMock } as unknown as SupabaseClient;

    const result = await listAuditEvents(fakeClient, scope, {
      limit: 10,
      offset: 0,
    });

    expect(result.events).toHaveLength(1);
    expect(result.total).toBe(1);
    expect(result.events[0].acao).toBe('org.member_added');
  });
});
