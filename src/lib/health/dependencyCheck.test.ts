import { describe, expect, it } from 'vitest';
import { evaluateDependencies, type DependencyCheck } from './dependencyCheck';

function okDependency(name: string): DependencyCheck {
  return { name, check: async () => ({ ok: true }) };
}

function absentDependency(name: string): DependencyCheck {
  return {
    name,
    check: async () => {
      throw new Error('ECONNREFUSED: dependency is absent');
    },
  };
}

function unauthorizedDependency(name: string): DependencyCheck {
  // Simulates a provider responding 401: the adapter treats this as ok:false, not a throw.
  return { name, check: async () => ({ ok: false }) };
}

function serverErrorDependency(name: string): DependencyCheck {
  return {
    name,
    check: async () => {
      throw new Error('upstream responded 503');
    },
  };
}

function hangingDependency(name: string): DependencyCheck {
  return {
    name,
    check: (signal: AbortSignal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      }),
  };
}

describe('evaluateDependencies', () => {
  it('reports ready when every dependency is healthy', async () => {
    const result = await evaluateDependencies([okDependency('database'), okDependency('cache')]);
    expect(result.status).toBe('ready');
    expect(result.checks).toEqual([
      { name: 'database', status: 'ok' },
      { name: 'cache', status: 'ok' },
    ]);
  });

  it('fails closed to not_ready when a dependency is absent (connection refused)', async () => {
    const result = await evaluateDependencies([absentDependency('database')]);
    expect(result.status).toBe('not_ready');
    expect(result.checks).toEqual([{ name: 'database', status: 'error' }]);
  });

  it('fails closed to not_ready when a dependency responds unauthorized (401)', async () => {
    const result = await evaluateDependencies([unauthorizedDependency('provider')]);
    expect(result.status).toBe('not_ready');
    expect(result.checks).toEqual([{ name: 'provider', status: 'error' }]);
  });

  it('fails closed to not_ready when a dependency throws a 5xx-shaped error', async () => {
    const result = await evaluateDependencies([serverErrorDependency('provider')]);
    expect(result.status).toBe('not_ready');
    expect(result.checks).toEqual([{ name: 'provider', status: 'error' }]);
  });

  it('fails closed to not_ready and reports timeout when a dependency hangs past the short timeout', async () => {
    const result = await evaluateDependencies([hangingDependency('database')], { timeoutMs: 20 });
    expect(result.status).toBe('not_ready');
    expect(result.checks).toEqual([{ name: 'database', status: 'timeout' }]);
  });

  it('is not_ready overall when only one of several dependencies fails', async () => {
    const result = await evaluateDependencies([okDependency('database'), absentDependency('cache')]);
    expect(result.status).toBe('not_ready');
    expect(result.checks).toEqual([
      { name: 'database', status: 'ok' },
      { name: 'cache', status: 'error' },
    ]);
  });

  it('invokes onError with a redacted outcome tag only, never the raw error object', async () => {
    const seen: Array<{ name: string; outcome: string }> = [];
    await evaluateDependencies([absentDependency('database')], {
      onError: (name, outcome) => seen.push({ name, outcome }),
    });
    expect(seen).toEqual([{ name: 'database', outcome: 'error' }]);
  });
});
