import { NextRequest, NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabaseServer';
import { getCorrelationId } from '@/lib/observability/correlation';
import { logger } from '@/lib/observability/logger';

export interface ReadinessCheckResult {
  status: 'ready' | 'not_ready';
  timestamp: string;
  version: string;
  checks: {
    database: 'ok' | 'error';
    schema: 'ok' | 'error';
  };
  durationMs: number;
}

export async function GET(req: NextRequest) {
  const startTime = Date.now();
  const correlationId = getCorrelationId(req);

  try {
    // 1. Validar conectividade básica com o banco de dados
    const { error: dbErr } = await supabaseServer
      .from('organizacoes')
      .select('id')
      .limit(1);

    if (dbErr) {
      logger.error('Readiness probe falhou na conexao com o banco', {
        subsystem: 'database',
        correlationId,
        error: dbErr.message,
      });

      const responsePayload: ReadinessCheckResult = {
        status: 'not_ready',
        timestamp: new Date().toISOString(),
        version: '0.1.0',
        checks: {
          database: 'error',
          schema: 'error',
        },
        durationMs: Date.now() - startTime,
      };

      return NextResponse.json(responsePayload, {
        status: 503,
        headers: { 'x-correlation-id': correlationId },
      });
    }

    const payload: ReadinessCheckResult = {
      status: 'ready',
      timestamp: new Date().toISOString(),
      version: '0.1.0',
      checks: {
        database: 'ok',
        schema: 'ok',
      },
      durationMs: Date.now() - startTime,
    };

    return NextResponse.json(payload, {
      status: 200,
      headers: {
        'x-correlation-id': correlationId,
        'cache-control': 'no-store, no-cache, must-revalidate',
      },
    });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : 'Erro interno';
    logger.error('Erro inesperado no probe de readiness', {
      subsystem: 'app',
      correlationId,
      error: errorMsg,
    });

    return NextResponse.json(
      {
        status: 'not_ready',
        timestamp: new Date().toISOString(),
        version: '0.1.0',
        checks: {
          database: 'error',
          schema: 'error',
        },
        durationMs: Date.now() - startTime,
      },
      {
        status: 503,
        headers: { 'x-correlation-id': correlationId },
      },
    );
  }
}
