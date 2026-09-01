import { NextResponse, after } from 'next/server';
import { syncService } from '../../../services/sync';
import { escopoTemCapacidade, resolveVerifiedOrganizationScope } from '../../../lib/requestOrganizationContext';
import { registrarFalhaInterna } from '../../../lib/observability/falhaInterna';

export const dynamic = 'force-dynamic';

/**
 * POST /api/sync
 * Agenda um job de sincronização durável e retorna imediatamente (202 Accepted).
 * O processamento ocorre em background via `after()`, fora do ciclo HTTP.
 */
export async function POST(request: Request) {
  try {
    // Ticket 22 — a autorização acontece aqui, uma vez. Antes o portão legado
    // perguntava por `app_metadata` e o serviço perguntava de novo, por outra
    // fonte, devolvendo a negação como exceção para a rota traduzir em status.
    const scopeResult = await resolveVerifiedOrganizationScope(request);
    if (scopeResult._tag !== 'RequestScopeResolved') return scopeResult.response;
    const scope = scopeResult.scope;
    if (!escopoTemCapacidade(scope, 'organization:manage')) {
      return NextResponse.json(
        { success: false, error: 'Acesso negado: apenas quem administra a organização pode sincronizar' },
        { status: 403 },
      );
    }

    // `?completa=1` ignora o checkpoint de `dataAlteracaoInicial` e relê tudo.
    // Necessário porque o checkpoint podia ficar envenenado: uma leitura que
    // falhava devolvia lista vazia, a etapa "concluía" com zero itens e o
    // marcador avançava assim mesmo — e daí em diante o Bling respondia zero
    // corretamente, para sempre.
    const completa = new URL(request.url).searchParams.get('completa') === '1';

    // 1. Registra job ou retorna job ativo existente (idempotente)
    const { jobId, status, isNew } = await syncService.enqueueSync(scope);

    // 2. Dispara processamento assíncrono após o envio da resposta
    //    Se o job já estava ativo (isNew=false), não dispara um segundo processo.
    if (isNew || status === 'queued') {
      after(async () => {
        await syncService.processJob(jobId, scope, { completa });
      });
    }

    return NextResponse.json(
      { success: true, jobId, status },
      { status: 202 },
    );
  } catch (error: unknown) {
    // A mensagem pública fica como estava; o diagnóstico, que antes se perdia
    // num `console.error` sem o erro, passa pelo registrador do Ticket 20.
    registrarFalhaInterna('sync.enfileirar', error);
    return NextResponse.json({ success: false, error: 'Erro interno na sincronização' }, { status: 500 });
  }
}
