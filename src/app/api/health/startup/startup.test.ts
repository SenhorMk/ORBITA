import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import type { DependencyCheck } from '@/lib/health/dependencyCheck';
import { startupResponse } from './route';

const VALID_ENV = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://abc123defghijklmno.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'a'.repeat(40),
  SUPABASE_SERVICE_ROLE_KEY: 'ci-test-fake-service-role-key-0001',
};

function okSchema(): DependencyCheck {
  return { name: 'schema', check: async () => ({ ok: true }) };
}
function absentSchema(): DependencyCheck {
  return {
    name: 'schema',
    check: async () => {
      throw new Error('relation "organizacoes" does not exist');
    },
  };
}

function startupRequest() {
  return new NextRequest('https://orbita.test/api/health/startup');
}

describe('GET /api/health/startup', () => {
  it('retorna 200 e status ready quando config e schema baseline estão válidos', async () => {
    const res = await startupResponse(startupRequest(), { env: VALID_ENV, schemaDependency: okSchema() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ready');
    expect(body.checks).toEqual({ config: 'ok', schema: 'ok' });
  });

  it('retorna 503 quando a configuração é placeholder, sem tentar consultar o banco', async () => {
    const res = await startupResponse(startupRequest(), {
      env: { ...VALID_ENV, SUPABASE_SERVICE_ROLE_KEY: 'placeholder' },
      schemaDependency: okSchema(),
    });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe('not_ready');
    expect(body.checks.config).toBe('error');
  });

  it('retorna 503 quando o schema baseline (migrations) ainda não existe', async () => {
    const res = await startupResponse(startupRequest(), { env: VALID_ENV, schemaDependency: absentSchema() });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.checks.schema).toBe('error');
  });

  it('nunca expõe URL, key, stack ou payload de provider no corpo da resposta não saudável', async () => {
    const res = await startupResponse(startupRequest(), {
      env: VALID_ENV,
      schemaDependency: {
        name: 'schema',
        check: async () => {
          throw new Error('connection to postgres://user:supersecret@10.0.0.1:5432/db failed');
        },
      },
    });
    const bodyText = await res.text();
    expect(bodyText).not.toMatch(/supersecret|postgres:\/\/|10\.0\.0\.1/);
  });
});
