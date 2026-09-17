import { NextResponse } from 'next/server';
import { syncService, FALHA_PUBLICA_DE_SINCRONIZACAO } from '../../../../services/sync';
import { resolveVerifiedOrganizationScope } from '../../../../lib/requestOrganizationContext';
import { registrarFalhaInterna, MENSAGEM_PUBLICA_DE_FALHA } from '../../../../lib/observability/falhaInterna';

export const dynamic = 'force-dynamic';

/**
 * GET /api/sync/status?job_id=<uuid>
 * Retorna o estado observável de um job de sincronização da organização autenticada.
 */
export async function GET(request: Request) {
  try {
    // A autorização acontece aqui, uma vez, pelo escopo verificado; o serviço
    // de sincronização recebe o escopo pronto e não repete a pergunta.
    const scopeResult = await resolveVerifiedOrganizationScope(request);
    if (scopeResult._tag !== 'RequestScopeResolved') return scopeResult.response;
    const scope = scopeResult.scope;

    const { searchParams } = new URL(request.url);
    const jobId = searchParams.get('job_id');

    if (!jobId) {
      return NextResponse.json(
        { success: false, error: 'Parâmetro job_id é obrigatório.' },
        { status: 400 },
      );
    }

    const job = await syncService.getJobStatus(jobId, scope);

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
        // A fronteira não confia no que está persistido. O produtor atual só
        // grava `SYNC_FAILED`, mas linhas antigas — e qualquer outro produtor —
        // podem carregar o texto do Postgres, com nome de constraint, `details`,
        // `hint` e valor de linha. Qualquer `last_error` não nulo sai como o
        // mesmo código público, independentemente do conteúdo (CWE-209).
        last_error: job.last_error === null || job.last_error === undefined
          ? null
          : FALHA_PUBLICA_DE_SINCRONIZACAO,
        created_at: job.created_at,
        updated_at: job.updated_at,
        completed_at: job.completed_at,
      },
    });
  } catch (error: unknown) {
    registrarFalhaInterna('sync.status.consultar', error);
    return NextResponse.json({ success: false, error: MENSAGEM_PUBLICA_DE_FALHA }, { status: 500 });
  }
}
