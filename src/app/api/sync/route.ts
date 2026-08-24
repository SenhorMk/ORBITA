import { NextResponse, after } from 'next/server';
import { syncService } from '../../../services/sync';
import { verifySessionAndRole } from '../../../lib/auth';

export const dynamic = 'force-dynamic';

/**
 * POST /api/sync
 * Agenda um job de sincronização durável e retorna imediatamente (202 Accepted).
 * O processamento ocorre em background via `after()`, fora do ciclo HTTP.
 */
export async function POST(request: Request) {
  try {
    const session = await verifySessionAndRole(request);
    if (!session) {
      return NextResponse.json({ success: false, error: 'Não autorizado' }, { status: 401 });
    }
    if (session.role !== 'dono') {
      return NextResponse.json(
        { success: false, error: 'Acesso negado: apenas dono pode sincronizar' },
        { status: 403 },
      );
    }

    // 1. Registra job ou retorna job ativo existente (idempotente)
    const { jobId, status, isNew } = await syncService.enqueueSync(session.tenant);

    // 2. Dispara processamento assíncrono após o envio da resposta
    //    Se o job já estava ativo (isNew=false), não dispara um segundo processo.
    if (isNew || status === 'queued') {
      after(async () => {
        await syncService.processJob(jobId, session.tenant);
      });
    }

    return NextResponse.json(
      { success: true, jobId, status },
      { status: 202 },
    );
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Erro interno na sincronização';
    console.error('❌ /api/sync POST:', msg);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
