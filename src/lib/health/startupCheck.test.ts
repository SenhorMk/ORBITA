import { describe, expect, it } from 'vitest';
import { evaluateStartup, evaluateStartupConfig } from './startupCheck';
import type { DependencyCheck } from './dependencyCheck';

const VALID_ENV = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://abc123defghijklmno.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'a'.repeat(40),
  SUPABASE_SERVICE_ROLE_KEY: 'ci-test-fake-service-role-key-0001',
};

function okSchema(): DependencyCheck {
  return { name: 'schema', check: async () => ({ ok: true }) };
}
function missingSchema(): DependencyCheck {
  return { name: 'schema', check: async () => ({ ok: false }) };
}
function absentSchema(): DependencyCheck {
  return {
    name: 'schema',
    check: async () => {
      throw new Error('relation "organizacoes" does not exist');
    },
  };
}
function hangingSchema(): DependencyCheck {
  return {
    name: 'schema',
    check: (signal: AbortSignal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('timeout')));
      }),
  };
}

describe('evaluateStartupConfig', () => {
  it('is ok when both browser and server Supabase configuration are valid', () => {
    expect(evaluateStartupConfig(VALID_ENV)).toBe('ok');
  });

  it('is error when the Supabase URL is a placeholder', () => {
    expect(evaluateStartupConfig({ ...VALID_ENV, NEXT_PUBLIC_SUPABASE_URL: 'https://seu-projeto.supabase.co' })).toBe(
      'error',
    );
  });

  it('is error when a required variable is entirely absent', () => {
    expect(evaluateStartupConfig({ ...VALID_ENV, SUPABASE_SERVICE_ROLE_KEY: undefined })).toBe('error');
  });

  it('is error when a key is too short to be real', () => {
    expect(evaluateStartupConfig({ ...VALID_ENV, SUPABASE_SERVICE_ROLE_KEY: 'short' })).toBe('error');
  });
});

describe('evaluateStartup', () => {
  it('is ready when config is valid and the baseline schema is present', async () => {
    const result = await evaluateStartup({ env: VALID_ENV, schemaDependency: okSchema() });
    expect(result).toEqual({ status: 'ready', checks: { config: 'ok', schema: 'ok' } });
  });

  it('is not_ready and never attempts the schema check when config is invalid (placeholder)', async () => {
    let called = false;
    const spySchema: DependencyCheck = {
      name: 'schema',
      check: async () => {
        called = true;
        return { ok: true };
      },
    };
    const result = await evaluateStartup({
      env: { ...VALID_ENV, NEXT_PUBLIC_SUPABASE_URL: 'https://placeholder.supabase.co' },
      schemaDependency: spySchema,
    });
    expect(result).toEqual({ status: 'not_ready', checks: { config: 'error', schema: 'error' } });
    expect(called).toBe(false);
  });

  it('is not_ready when the baseline schema is missing (migrations not applied)', async () => {
    const result = await evaluateStartup({ env: VALID_ENV, schemaDependency: missingSchema() });
    expect(result).toEqual({ status: 'not_ready', checks: { config: 'ok', schema: 'error' } });
  });

  it('is not_ready when the schema dependency is entirely absent', async () => {
    const result = await evaluateStartup({ env: VALID_ENV, schemaDependency: absentSchema() });
    expect(result).toEqual({ status: 'not_ready', checks: { config: 'ok', schema: 'error' } });
  });

  it('is not_ready and reports timeout when the schema dependency hangs', async () => {
    const result = await evaluateStartup({ env: VALID_ENV, schemaDependency: hangingSchema(), timeoutMs: 20 });
    expect(result).toEqual({ status: 'not_ready', checks: { config: 'ok', schema: 'timeout' } });
  });
});
