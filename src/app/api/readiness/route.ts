import { NextRequest, NextResponse } from 'next/server';
import { evaluateDependencies, type DependencyCheck } from '@/lib/health/dependencyCheck';
import { getCorrelationId } from '@/lib/observability/correlation';
import { logger } from '@/lib/observability/logger';

/** Short, fail-closed timeout for each indispensable dependency (ms). */
const READINESS_TIMEOUT_MS = 2000;

export interface ReadinessCheckResult {
  status: 'ready' | 'not_ready';
  timestamp: string;
  checks: Record<string, 'ok' | 'error' | 'timeout'>;
  durationMs: number;
}

/**
 * Build the readiness response from an injected list of indispensable dependencies.
 * Exported for testing so unit tests can inject fake dependencies instead of mocking
 * `@/lib/supabaseServer`, which would require the real server environment to load.
 *
 * The response body never includes a URL, key, stack trace, or raw provider payload —
 * only the stable dependency name and a coarse status tag.
 */
export async function readinessResponse(
  req: NextRequest,
  dependencies: readonly DependencyCheck[],
): Promise<NextResponse> {
  const startTime = Date.now();
  const correlationId = getCorrelationId(req);

  const result = await evaluateDependencies(dependencies, {
    timeoutMs: READINESS_TIMEOUT_MS,
    onError: (name, outcome) => {
      logger.error('Readiness probe: dependência indisponível', {
        subsystem: 'app',
        correlationId,
        dependency: name,
        outcome,
      });
    },
  });

  const checks: Record<string, 'ok' | 'error' | 'timeout'> = {};
  for (const check of result.checks) checks[check.name] = check.status;

  const payload: ReadinessCheckResult = {
    status: result.status,
    timestamp: new Date().toISOString(),
    checks,
    durationMs: Date.now() - startTime,
  };

  return NextResponse.json(payload, {
    status: result.status === 'ready' ? 200 : 503,
    headers: {
      'x-correlation-id': correlationId,
      'cache-control': 'no-store, no-cache, must-revalidate',
    },
  });
}

/**
 * Resolves the production dependency list via a lazy dynamic import so that importing
 * this route module (as `readinessResponse` unit tests do) never constructs the real
 * `supabaseServer` client, which throws synchronously on invalid/placeholder configuration.
 * That throw is exactly the "missing indispensable dependency" case readiness must report
 * as 503, not crash on.
 */
async function resolveProductionDependencies(): Promise<readonly DependencyCheck[]> {
  const { databaseDependency } = await import('@/lib/health/databaseDependency');
  return [databaseDependency];
}

export async function GET(req: NextRequest) {
  const correlationId = getCorrelationId(req);
  try {
    const dependencies = await resolveProductionDependencies();
    return await readinessResponse(req, dependencies);
  } catch (cause) {
    logger.error('Readiness probe: configuração de dependência indisponível', {
      subsystem: 'app',
      correlationId,
    });
    const payload: ReadinessCheckResult = {
      status: 'not_ready',
      timestamp: new Date().toISOString(),
      checks: { database: 'error' },
      durationMs: 0,
    };
    void cause;
    return NextResponse.json(payload, {
      status: 503,
      headers: {
        'x-correlation-id': correlationId,
        'cache-control': 'no-store, no-cache, must-revalidate',
      },
    });
  }
}
