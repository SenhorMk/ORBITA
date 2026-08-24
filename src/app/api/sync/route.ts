import { NextResponse, after } from 'next/server';
import { syncService, SyncAuthorizationStoreUnavailableError, SyncScopeDeniedError } from '../../../services/sync';
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
    const { jobId, status, isNew } = await syncService.enqueueSync(session);

    // 2. Dispara processamento assíncrono após o envio da resposta
    //    Se o job já estava ativo (isNew=false), não dispara um segundo processo.
    if (isNew || status === 'queued') {
      after(async () => {
        await syncService.processJob(jobId, session);
      });
    }

    return NextResponse.json(
      { success: true, jobId, status },
      { status: 202 },
    );
  } catch (error: unknown) {
    if (error instanceof SyncScopeDeniedError) {
      return NextResponse.json({ success: false, error: 'Escopo organizacional inválido' }, { status: 403 });
    }
    if (error instanceof SyncAuthorizationStoreUnavailableError) {
      return NextResponse.json({ success: false, error: 'Serviço de autorização indisponível' }, { status: 503 });
    }
    console.error('❌ /api/sync POST: falha interna não classificada');
    return NextResponse.json({ success: false, error: 'Erro interno na sincronização' }, { status: 500 });
  }
}
