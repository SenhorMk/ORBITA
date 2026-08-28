import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import type { DependencyCheck } from '@/lib/health/dependencyCheck';
import { readinessResponse } from './route';

/** Fakes escritos à mão (sem `vi.mock`), proibido pelo contrato de execução dos tickets 07-25. */
function okDatabase(): DependencyCheck {
  return { name: 'database', check: async () => ({ ok: true }) };
}
function absentDatabase(): DependencyCheck {
  return {
    name: 'database',
    check: async () => {
      throw new Error('ECONNREFUSED');
    },
  };
}
function placeholderDatabase(): DependencyCheck {
  // Simula config placeholder: o adapter real detecta e retorna ok:false, sem lançar.
  return { name: 'database', check: async () => ({ ok: false }) };
}
function timeoutDatabase(): DependencyCheck {
  return {
    name: 'database',
    check: (signal: AbortSignal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('timeout')));
      }),
  };
}
function unauthorizedDatabase(): DependencyCheck {
  return { name: 'database', check: async () => ({ ok: false }) };
}
function serverErrorDatabase(): DependencyCheck {
  return {
    name: 'database',
    check: async () => {
      throw new Error('upstream 503');
    },
  };
}

function readinessRequest() {
  return new NextRequest('https://orbita.test/api/readiness');
}

describe('GET /api/readiness', () => {
  it('retorna 200 e status ready quando toda dependência indispensável está saudável', async () => {
    const res = await readinessResponse(readinessRequest(), [okDatabase()]);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ready');
    expect(body.checks.database).toBe('ok');
    expect(res.headers.get('x-correlation-id')).toBeTruthy();
  });

  it('retorna 503 quando a dependência de banco está ausente (connection refused)', async () => {
    const res = await readinessResponse(readinessRequest(), [absentDatabase()]);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe('not_ready');
    expect(body.checks.database).toBe('error');
  });

  it('retorna 503 quando a dependência reporta configuração placeholder (ok:false)', async () => {
    const res = await readinessResponse(readinessRequest(), [placeholderDatabase()]);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.checks.database).toBe('error');
  });

  it('retorna 503 e reporta timeout quando a dependência não responde dentro do prazo curto', async () => {
    const res = await readinessResponse(readinessRequest(), [timeoutDatabase()]);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.checks.database).toBe('timeout');
  });

  it('retorna 503 quando a dependência responde não autorizado (401)', async () => {
    const res = await readinessResponse(readinessRequest(), [unauthorizedDatabase()]);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.checks.database).toBe('error');
  });

  it('retorna 503 quando a dependência lança um erro 5xx', async () => {
    const res = await readinessResponse(readinessRequest(), [serverErrorDatabase()]);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.checks.database).toBe('error');
  });

  it('nunca expõe URL, key, stack ou payload de provider no corpo da resposta não saudável', async () => {
    const res = await readinessResponse(readinessRequest(), [
      {
        name: 'database',
        check: async () => {
          throw new Error('connection to postgres://user:supersecret@10.0.0.1:5432/db failed');
        },
      },
    ]);
    const bodyText = await res.text();
    expect(bodyText).not.toMatch(/supersecret|postgres:\/\/|10\.0\.0\.1/);
    expect(bodyText).not.toMatch(/at\s+\S+\s+\(.*:\d+:\d+\)/); // sem stack trace
  });
});
