import fs from 'node:fs';
import path from 'node:path';

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

/**
 * O catálogo executável (este arquivo TypeScript) e a projeção SQL
 * (`catalogo_eventos_auditoria`, semeada pelas migrations) listam os mesmos
 * eventos, com a mesma severidade, o mesmo ator e a mesma retenção.
 *
 * Até a migration 69 os dois só concordavam por disciplina: nenhum teste os
 * comparava. Um evento acrescentado de um lado só passaria despercebido.
 */
describe('catálogo TypeScript × projeção SQL', () => {
  function eventosSemeadosNasMigrations(): Map<string, { severidade: string; ator: string; retencao: number }> {
    const diretorio = path.resolve(process.cwd(), 'database');
    const eventos = new Map<string, { severidade: string; ator: string; retencao: number }>();
    for (const arquivo of fs.readdirSync(diretorio).filter((nome) => /^\d+_.*\.sql$/u.test(nome))) {
      const sql = fs.readFileSync(path.join(diretorio, arquivo), 'utf8');
      if (!/insert into public\.catalogo_eventos_auditoria/iu.test(sql)) continue;
      // Uma linha de valores: ('nome', versao, 'produtor', 'severidade', 'ator', retencao, ...
      for (const [, nome, severidade, ator, retencao] of sql.matchAll(
        /\(\s*'([a-z_]+\.[a-z_]+)',\s*\d+,\s*'[a-z_]+',\s*'([a-z]+)',\s*'([a-z]+)',\s*(\d+)/gu,
      )) {
        eventos.set(nome!, { severidade: severidade!, ator: ator!, retencao: Number(retencao) });
      }
    }
    return eventos;
  }

  it('os dois lados têm exatamente os mesmos eventos', () => {
    const sql = eventosSemeadosNasMigrations();
    expect([...sql.keys()].sort()).toEqual(AUDIT_EVENT_CATALOG.map((e) => e.nome).sort());
  });

  it('severidade, ator esperado e retenção coincidem', () => {
    const sql = eventosSemeadosNasMigrations();
    for (const evento of AUDIT_EVENT_CATALOG) {
      expect(sql.get(evento.nome), evento.nome).toEqual({
        severidade: evento.severidade,
        ator: evento.atorEsperado,
        retencao: evento.retentionDias,
      });
    }
  });

  it('a correção operacional acrescenta os eventos de contato e despesa, e nenhum de reset', () => {
    const nomes = AUDIT_EVENT_CATALOG.map((e) => e.nome);
    expect(nomes).toEqual(expect.arrayContaining([
      'customer.contact_deleted',
      'customer.contact_reconcile_required',
      'finance.entry_deleted',
      'finance.expense_cancelled',
      'finance.remote_reconcile_required',
    ]));
    // `auth.password_reset_requested` é redefinição de senha, não reset de dados.
    expect(nomes.filter((n) => /^(org|customer|finance)\..*reset/u.test(n))).toEqual([]);
    expect(nomes).not.toContain('finance.expense_reversed');
  });
});
