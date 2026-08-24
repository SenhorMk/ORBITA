import { NextResponse } from 'next/server';
import { syncService, SyncAuthorizationStoreUnavailableError, SyncScopeDeniedError } from '../../../../services/sync';
import { verifySessionAndRole } from '../../../../lib/auth';

export const dynamic = 'force-dynamic';

/**
 * GET /api/sync/status?job_id=<uuid>
 * Retorna o estado observável de um job de sincronização da organização autenticada.
 */
export async function GET(request: Request) {
  try {
    const session = await verifySessionAndRole(request);
    if (!session) {
      return NextResponse.json({ success: false, error: 'Não autorizado' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const jobId = searchParams.get('job_id');

    if (!jobId) {
      return NextResponse.json(
        { success: false, error: 'Parâmetro job_id é obrigatório.' },
        { status: 400 },
      );
    }

    const job = await syncService.getJobStatus(jobId, session);

    if (!job) {
      return NextResponse.json(
        { success: false, error: 'Job não encontrado ou sem permissão.' },
        { status: 404 },
      );
    }

    return NextResponse.json({
      success: true,
      job: {
        id: job.id,
        status: job.status,
        progress: job.progress,
        last_error: job.last_error,
        created_at: job.created_at,
        updated_at: job.updated_at,
        completed_at: job.completed_at,
      },
    });
  } catch (error: unknown) {
    if (error instanceof SyncScopeDeniedError) {
      return NextResponse.json({ success: false, error: 'Escopo organizacional inválido' }, { status: 403 });
    }
    if (error instanceof SyncAuthorizationStoreUnavailableError) {
      return NextResponse.json({ success: false, error: 'Serviço de autorização indisponível' }, { status: 503 });
    }
    console.error('❌ /api/sync/status GET: falha interna não classificada');
    return NextResponse.json({ success: false, error: 'Erro interno' }, { status: 500 });
  }
}
