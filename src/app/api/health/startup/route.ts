import { NextRequest, NextResponse } from 'next/server';
import { evaluateStartup, type EvaluateStartupOptions } from '@/lib/health/startupCheck';
import { getCorrelationId } from '@/lib/observability/correlation';
import { logger } from '@/lib/observability/logger';

/**
 * Startup probe (distinct from the unrelated business endpoint `POST /api/startup`, which
 * triggers the Bling initial sync — see `docs/quality/ticket-21-deploy-readiness-audit.md`).
 * Proves initialization succeeded: valid non-placeholder configuration and a database that
 * already carries the expected baseline schema. Read-only; never runs or triggers a migration.
 */
const STARTUP_TIMEOUT_MS = 3000;

export interface StartupProbeResult {
  status: 'ready' | 'not_ready';
  timestamp: string;
  checks: { config: 'ok' | 'error'; schema: 'ok' | 'error' | 'timeout' };
  durationMs: number;
}

export async function startupResponse(
  req: NextRequest,
  options: EvaluateStartupOptions,
): Promise<NextResponse> {
  const startTime = Date.now();
  const correlationId = getCorrelationId(req);

  const result = await evaluateStartup({ timeoutMs: STARTUP_TIMEOUT_MS, ...options });

  if (result.status !== 'ready') {
    logger.error('Startup probe: inicialização incompleta', {
      subsystem: 'app',
      correlationId,
      config: result.checks.config,
      schema: result.checks.schema,
    });
  }

  const payload: StartupProbeResult = {
    status: result.status,
    timestamp: new Date().toISOString(),
    checks: result.checks,
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

export async function GET(req: NextRequest) {
  const correlationId = getCorrelationId(req);
  try {
    const { schemaDependency } = await import('@/lib/health/schemaDependency');
    return await startupResponse(req, { schemaDependency });
  } catch (cause) {
    logger.error('Startup probe: configuração de dependência indisponível', {
      subsystem: 'app',
      correlationId,
    });
    void cause;
    const payload: StartupProbeResult = {
      status: 'not_ready',
      timestamp: new Date().toISOString(),
      checks: { config: 'error', schema: 'error' },
      durationMs: 0,
    };
    return NextResponse.json(payload, {
      status: 503,
      headers: {
        'x-correlation-id': correlationId,
        'cache-control': 'no-store, no-cache, must-revalidate',
      },
    });
  }
}
