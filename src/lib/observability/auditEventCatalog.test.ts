import { describe, it, expect } from 'vitest';
import {
  AUDIT_EVENT_CATALOG_VERSION,
  AUDIT_EVENT_CATALOG,
  getAuditEventDefinition,
  isKnownAuditEvent,
  validateAuditEventMetadata,
} from './auditEventCatalog';

describe('auditEventCatalog', () => {
  it('expõe uma versão do catálogo e uma lista não vazia de eventos', () => {
    expect(typeof AUDIT_EVENT_CATALOG_VERSION).toBe('number');
    expect(AUDIT_EVENT_CATALOG_VERSION).toBeGreaterThanOrEqual(1);
    expect(AUDIT_EVENT_CATALOG.length).toBeGreaterThan(10);
  });

  it('cobre as famílias de eventos exigidas pelo ticket 19', () => {
    const names = AUDIT_EVENT_CATALOG.map((e) => e.nome);
    const expectedPrefixes = [
      'auth.',
      'membership.',
      'capability.',
      'billing.',
      'oauth.',
      'webhook.',
      'job.',
      'privacy.',
      'security.',
      'org.',
    ];
    for (const prefix of expectedPrefixes) {
      expect(names.some((n) => n.startsWith(prefix))).toBe(true);
    }
  });

  it('todo evento do catálogo tem produtor, severidade, atorEsperado e retentionDias válidos', () => {
    for (const evt of AUDIT_EVENT_CATALOG) {
      expect(evt.nome.length).toBeGreaterThan(0);
      expect(['info', 'warning', 'critical']).toContain(evt.severidade);
      expect(['user', 'system']).toContain(evt.atorEsperado);
      expect(evt.retentionDias).toBeGreaterThan(0);
      expect(Array.isArray(evt.camposProibidos)).toBe(true);
    }
  });

  it('isKnownAuditEvent retorna true para evento catalogado e false para desconhecido', () => {
    expect(isKnownAuditEvent('auth.login_failed')).toBe(true);
    expect(isKnownAuditEvent('evento.inexistente.forjado')).toBe(false);
  });

  it('getAuditEventDefinition retorna a definição de auth.login_failed com severidade warning', () => {
    const def = getAuditEventDefinition('auth.login_failed');
    expect(def).toBeDefined();
    expect(def?.severidade).toBe('warning');
  });

  it('validateAuditEventMetadata rejeita evento fora do catálogo', () => {
    const result = validateAuditEventMetadata('evento.forjado', {});
    expect(result._tag).toBe('UnknownEvent');
  });

  it('validateAuditEventMetadata rejeita metadata contendo campo explicitamente proibido do evento', () => {
    // billing.owner_changed proíbe carregar dados de cartão/pagamento no metadata
    const result = validateAuditEventMetadata('billing.owner_changed', {
      cardNumber: '4111111111111111',
    });
    expect(result._tag).toBe('ForbiddenField');
  });

  it('validateAuditEventMetadata aceita metadata sem campos proibidos', () => {
    const result = validateAuditEventMetadata('billing.owner_changed', {
      previousOwnerId: 'user-1',
      newOwnerId: 'user-2',
    });
    expect(result._tag).toBe('Valid');
  });

  it('security.cross_tenant_attempt é severidade critical e ator esperado system', () => {
    const def = getAuditEventDefinition('security.cross_tenant_attempt');
    expect(def?.severidade).toBe('critical');
    expect(def?.atorEsperado).toBe('system');
  });
});
