import { describe, expect, it } from 'vitest';

import {
  SYNTHETIC_DATA_PREFIX,
  buildSeedManifest,
  filterSyntheticRecords,
  findOrganization,
  findPersona,
  isFromManifestRun,
  isSyntheticIdentifier,
  requirePersonaUserId,
  withPersonaUserId,
} from './syntheticSeedData';

const fixedClock = () => new Date('2026-08-28T12:00:00.000Z');
const fixedRandom = () => 0.123456789;

describe('buildSeedManifest', () => {
  it('gera duas organizações sintéticas (A e B) e cinco personas cobrindo owner/admin/member/external', () => {
    const manifest = buildSeedManifest({ runId: 'fixed-run', clock: fixedClock });

    expect(manifest.organizations).toHaveLength(2);
    expect(manifest.personas).toHaveLength(5);

    const roles = manifest.personas.map((persona) => persona.role).sort();
    expect(roles).toEqual(['admin', 'external', 'member', 'owner', 'owner'].sort());
  });

  it('prefixa todos os slugs e e-mails sintéticos com SYNTHETIC_DATA_PREFIX', () => {
    const manifest = buildSeedManifest({ runId: 'fixed-run', clock: fixedClock });

    for (const organization of manifest.organizations) {
      expect(organization.slug).toContain(SYNTHETIC_DATA_PREFIX);
    }
    for (const persona of manifest.personas) {
      expect(persona.email).toContain(SYNTHETIC_DATA_PREFIX);
    }
  });

  it('associa cada persona não-externa a uma organização existente no manifest', () => {
    const manifest = buildSeedManifest({ runId: 'fixed-run', clock: fixedClock });
    const organizationKeys = new Set(manifest.organizations.map((org) => org.key));

    for (const persona of manifest.personas) {
      if (persona.organizationKey === null) continue;
      expect(organizationKeys.has(persona.organizationKey)).toBe(true);
    }
  });

  it('a persona "external" não pertence a nenhuma organização (fora de A e B)', () => {
    const manifest = buildSeedManifest({ runId: 'fixed-run', clock: fixedClock });
    const external = manifest.personas.find((candidate) => candidate.key === 'external');
    expect(external?.organizationKey).toBeNull();
  });

  it('é determinístico quando runId/clock são fixados (mesmo manifest byte-a-byte)', () => {
    const first = buildSeedManifest({ runId: 'fixed-run', clock: fixedClock });
    const second = buildSeedManifest({ runId: 'fixed-run', clock: fixedClock });
    expect(first).toEqual(second);
  });

  it('gera runIds diferentes entre execuções quando runId não é fixado', () => {
    let counter = 0;
    const incrementingRandom = () => {
      counter += 1;
      return counter / 100;
    };
    const first = buildSeedManifest({ clock: fixedClock, random: incrementingRandom });
    const second = buildSeedManifest({ clock: fixedClock, random: incrementingRandom });
    expect(first.runId).not.toBe(second.runId);
  });

  it('gera senhas sintéticas não vazias e distintas por persona', () => {
    const manifest = buildSeedManifest({ runId: 'fixed-run', clock: fixedClock, random: fixedRandom });
    const passwords = manifest.personas.map((persona) => persona.password);
    expect(new Set(passwords).size).toBe(passwords.length);
    for (const password of passwords) {
      expect(password.length).toBeGreaterThanOrEqual(12);
    }
  });
});

describe('isSyntheticIdentifier / isFromManifestRun', () => {
  it('identifica qualquer valor com o prefixo sintético global', () => {
    expect(isSyntheticIdentifier('orbita-e2e-run1-owner-a@e2e.orbita.test')).toBe(true);
    expect(isSyntheticIdentifier('cliente.real@empresa.com')).toBe(false);
  });

  it('distingue registros do run específico do manifest de outros runs sintéticos', () => {
    const manifest = buildSeedManifest({ runId: 'run-a', clock: fixedClock });
    const otherRunValue = `${SYNTHETIC_DATA_PREFIX}run-b-owner-a@e2e.orbita.test`;

    expect(isFromManifestRun(manifest, manifest.personas[0]!.email)).toBe(true);
    expect(isFromManifestRun(manifest, otherRunValue)).toBe(false);
  });
});

describe('filterSyntheticRecords', () => {
  it('mantém apenas registros com slug, email ou nome sintéticos e descarta dados reais', () => {
    const records = [
      { slug: `${SYNTHETIC_DATA_PREFIX}run-a-org-a`, nome: 'ORBITA E2E Org A' },
      { slug: 'empresa-cliente-real', nome: 'Empresa Cliente Real' },
      { email: `${SYNTHETIC_DATA_PREFIX}run-a-owner-a@e2e.orbita.test` },
      { email: 'usuario.real@empresa.com' },
    ];

    const filtered = filterSyntheticRecords(records);
    expect(filtered).toHaveLength(2);
    expect(filtered.every((record) => record.slug?.includes(SYNTHETIC_DATA_PREFIX) || record.email?.includes(SYNTHETIC_DATA_PREFIX))).toBe(
      true,
    );
  });

  it('retorna lista vazia quando nenhum registro é sintético (nunca apaga dados reais por engano)', () => {
    const records = [{ slug: 'empresa-real' }, { email: 'real@empresa.com' }];
    expect(filterSyntheticRecords(records)).toHaveLength(0);
  });
});

describe('findOrganization / findPersona', () => {
  it('resolve organização e persona pela chave lógica', () => {
    const manifest = buildSeedManifest({ runId: 'fixed-run', clock: fixedClock });
    expect(findOrganization(manifest, 'org-a').key).toBe('org-a');
    expect(findPersona(manifest, 'owner-a').role).toBe('owner');
  });

  it('lança erro explícito para chave inexistente em vez de retornar undefined silenciosamente', () => {
    const manifest = buildSeedManifest({ runId: 'fixed-run', clock: fixedClock });
    expect(() => findOrganization(manifest, 'org-z')).toThrow(/não encontrada/);
    expect(() => findPersona(manifest, 'ghost')).toThrow(/não encontrada/);
  });
});

describe('requirePersonaUserId / withPersonaUserId', () => {
  it('lança erro quando a persona ainda não tem userId real (nunca inventa um id)', () => {
    const manifest = buildSeedManifest({ runId: 'fixed-run', clock: fixedClock });
    const owner = findPersona(manifest, 'owner-a');
    expect(owner.userId).toBeUndefined();
    expect(() => requirePersonaUserId(owner)).toThrow(/ainda não tem userId real/);
  });

  it('withPersonaUserId anexa o id real apenas à persona indicada, sem mutar o manifest original', () => {
    const manifest = buildSeedManifest({ runId: 'fixed-run', clock: fixedClock });
    const updated = withPersonaUserId(manifest, 'owner-a', 'real-supabase-user-id-123');

    expect(findPersona(manifest, 'owner-a').userId).toBeUndefined();
    expect(requirePersonaUserId(findPersona(updated, 'owner-a'))).toBe('real-supabase-user-id-123');
    expect(findPersona(updated, 'admin-a').userId).toBeUndefined();
  });
});
