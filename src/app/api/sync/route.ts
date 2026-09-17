import { NextResponse, after } from 'next/server';
import { syncService } from '../../../services/sync';
import { escopoTemCapacidade, resolveVerifiedOrganizationScope } from '../../../lib/requestOrganizationContext';
import { registrarFalhaInterna } from '../../../lib/observability/falhaInterna';

export const dynamic = 'force-dynamic';

/**
 * POST /api/sync
 * Agenda um job de sincronização durável e retorna imediatamente (202 Accepted).
 * O processamento ocorre em background via `after()`, fora do ciclo HTTP.
 *
 * ## Semântica temporal da autorização — política escolhida, não acidente
 *
 * A autorização acontece **uma vez**, antes da resposta 202. O `after()` recebe
 * o escopo já verificado e não reautoriza. A consequência é explícita:
 *
 * > Um job validamente enfileirado **continua até o fim** mesmo que o vínculo
 * > do ator seja revogado depois que o 202 saiu.
 *
 * É a política escolhida, por dois motivos. O escopo é da **organização**, e
 * revogar um membro não retira da organização o direito de ter os próprios
 * dados sincronizados — o job pertence à organização, não à pessoa. E
 * reautorizar no meio deixaria a sincronização pela metade, com o checkpoint
 * avançado, que é exatamente o estado que o `?completa=1` existe para consertar.
 *
 * O que a revogação **impede** é enfileirar um job novo: a próxima chamada é
 * negada com 403 na fronteira. A janela é a duração de um job, não indefinida.
 *
 * Se algum dia a política precisar mudar, o lugar é aqui — passar a reautorizar
 * dentro do `after()`, aceitando o custo de sincronização interrompida.
 */
export async function POST(request: Request) {
  try {
    // A autorização acontece aqui, uma vez, pelo escopo verificado; o serviço
    // de sincronização recebe o escopo pronto e não repete a pergunta.
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
    // O cliente recebe a frase pública fixa; o diagnóstico vai para o log por
    // `registrarFalhaInterna`.
    registrarFalhaInterna('sync.enfileirar', error);
    return NextResponse.json({ success: false, error: 'Erro interno na sincronização' }, { status: 500 });
  }
}
