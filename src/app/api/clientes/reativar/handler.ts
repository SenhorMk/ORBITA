import { NextResponse } from 'next/server';
import { z } from 'zod';

import {
  STATUS_HTTP_DA_REATIVACAO,
  type RespostaDaReativacao,
} from '@/lib/config/reativacaoDeContatoContract';
import type { ContatoRemoto, LeituraRemota } from '@/lib/integrations/bling/operacaoRemotaContract';
import { registrarFalhaInterna } from '@/lib/observability/falhaInterna';
import { logger } from '@/lib/observability/logger';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';

/**
 * `POST /api/clientes/reativar` — a reconciliação explícita de um contato com
 * exclusão aberta no Bling (PRE-005), confirmada ou aguardando conferência. É
 * o **único** caminho de saída: nenhum evento do webhook nem a sincronização
 * reativam sozinhos.
 *
 * 1. escopo verificado e `organization:manage` (quem pode); o banco confere o
 *    papel de novo;
 * 2. só o `blingId` vem do corpo, e só vale dentro da organização do escopo;
 * 3. sem exclusão aberta, nada a fazer (`NotExcluded`);
 * 4. o contato é **lido** no Bling: só um `200` com o **mesmo id** e a
 *    situação `A` (Ativo) prova que ele voltou e pode vender. `404` ou `E` →
 *    `Blocked` (ainda excluído); `I` ou `S` → `Blocked` (existe, mas não está
 *    ativo); id divergente, situação vazia ou fora das documentadas, ou
 *    leitura indeterminada → `ReconcileRequired`; recusa → `ProviderRefused`.
 *    Nada é reativado sem prova;
 * 5. `A` → `reativar_contato_excluido_no_bling`, que encerra a exclusão
 *    aberta (o registro fica, com quem e quando) e libera o contato local. Os
 *    dados dele voltam a ser atualizados pelo próximo evento ou sincronização;
 * 6. exclusão **pendente** e o Bling prova a exclusão (`404` ou `E`) →
 *    `confirmar_exclusao_pendente_de_contato`: a pendência vira exclusão
 *    confirmada e o contato fica marcado como excluído (`ExclusionConfirmed`).
 *    Qualquer outra leitura deixa a pendência como está.
 */

export interface ReativacaoDeContatoStorePort {
  estadoDaExclusaoNoBling(scope: VerifiedOrganizationScope, blingId: string): Promise<'nenhuma' | 'confirmada' | 'pendente'>;
  reativarExcluidoNoBling(scope: VerifiedOrganizationScope, blingId: string): Promise<'reativado' | 'nao_excluido' | 'negado'>;
  confirmarExclusaoPendente(scope: VerifiedOrganizationScope, blingId: string): Promise<'confirmada' | 'sem_pendencia' | 'negado'>;
}

export interface EventoDeReativacao {
  readonly acao: 'customer.contact_reactivated' | 'customer.contact_deletion_confirmed';
  readonly recurso: 'cliente';
  readonly recursoId: string;
  readonly correlationId: string;
  readonly metadata: Readonly<Record<string, string | boolean>>;
}

export interface ReativacaoDeContatoDependencies {
  readonly autorizar: (request: Request) => Promise<
    | { readonly _tag: 'Autorizado'; readonly scope: VerifiedOrganizationScope }
    | { readonly _tag: 'Negado'; readonly response: NextResponse }
  >;
  readonly store: ReativacaoDeContatoStorePort;
  readonly bling: (scope: VerifiedOrganizationScope) => { consultarContato(id: string): Promise<LeituraRemota<ContatoRemoto>> };
  readonly auditar: (scope: VerifiedOrganizationScope, evento: EventoDeReativacao) => Promise<void>;
  readonly correlationId: (request: Request) => string;
}

const corpoSchema = z.object({ blingId: z.string().regex(/^[1-9][0-9]*$/) });

function responder(corpo: RespostaDaReativacao): NextResponse {
  return NextResponse.json(corpo, { status: STATUS_HTTP_DA_REATIVACAO[corpo.resultado] });
}

/** As situações de contato que o Bling documenta (`POST`/`PUT /contatos`). */
const situacaoDoContatoNoBlingSchema = z.enum(['A', 'E', 'I', 'S']);

/** O que a leitura do Bling prova; só `Ativo` libera a reativação. */
function provaRemota(leitura: LeituraRemota<ContatoRemoto>, blingId: string): 'Ativo' | RespostaDaReativacao {
  switch (leitura._tag) {
    case 'RemotoAusente':
      return { resultado: 'Blocked', motivo: 'ainda_excluido_no_bling' };
    case 'RemotoRecusou':
      return { resultado: 'ProviderRefused', motivo: 'recusado_pelo_bling' };
    case 'RemotoLimitado':
      return { resultado: 'ProviderRefused', motivo: 'limite_de_requisicoes' };
    case 'RemotoIndeterminado':
      return { resultado: 'ReconcileRequired' };
    case 'RemotoPresente': {
      // Outro id na resposta não prova nada sobre o contato pedido.
      if (leitura.valor.id !== blingId) return { resultado: 'ReconcileRequired' };
      const situacao = situacaoDoContatoNoBlingSchema.safeParse(leitura.valor.situacao);
      if (!situacao.success) return { resultado: 'ReconcileRequired' };
      switch (situacao.data) {
        case 'A':
          return 'Ativo';
        case 'E':
          return { resultado: 'Blocked', motivo: 'ainda_excluido_no_bling' };
        case 'I':
        case 'S':
          return { resultado: 'Blocked', motivo: 'nao_ativo_no_bling' };
      }
    }
  }
}

export function createReativacaoDeContatoHandler(deps: ReativacaoDeContatoDependencies) {
  return async function reativarContato(request: Request): Promise<NextResponse> {
    const autorizacao = await deps.autorizar(request);
    if (autorizacao._tag === 'Negado') return autorizacao.response;
    const { scope } = autorizacao;

    let corpo: unknown;
    try {
      corpo = await request.json();
    } catch {
      return responder({ resultado: 'InvalidRequest' });
    }
    const lido = corpoSchema.safeParse(corpo);
    if (!lido.success) return responder({ resultado: 'InvalidRequest' });
    const { blingId } = lido.data;
    const correlationId = deps.correlationId(request);
    const contexto = { subsystem: 'app' as const, correlationId, organizacaoId: scope.organizationId, blingId };

    const estado = await deps.store.estadoDaExclusaoNoBling(scope, blingId);
    if (estado === 'nenhuma') return responder({ resultado: 'NotExcluded' });

    const prova = provaRemota(await deps.bling(scope).consultarContato(blingId), blingId);
    const confirmaExclusao = estado === 'pendente' && prova !== 'Ativo'
      && prova.resultado === 'Blocked' && prova.motivo === 'ainda_excluido_no_bling';
    if (prova !== 'Ativo' && !confirmaExclusao) {
      logger.warn('clientes.reativacao.recusada', { ...contexto, estado, outcome: prova.resultado });
      return responder(prova);
    }

    const desfecho = confirmaExclusao
      ? await deps.store.confirmarExclusaoPendente(scope, blingId)
      : await deps.store.reativarExcluidoNoBling(scope, blingId);
    if (desfecho === 'negado') return responder({ resultado: 'Forbidden' });
    // A exclusão aberta mudou entre a leitura e o comando: nada foi feito aqui.
    if (desfecho === 'nao_excluido' || desfecho === 'sem_pendencia') return responder({ resultado: 'ReconcileRequired' });

    const acao = confirmaExclusao ? 'customer.contact_deletion_confirmed' : 'customer.contact_reactivated';
    logger.info('clientes.reativacao.concluida', { ...contexto, estado, outcome: desfecho });
    try {
      await deps.auditar(scope, {
        acao,
        recurso: 'cliente',
        recursoId: blingId,
        correlationId,
        metadata: { bling_id: blingId, estado_anterior: estado, estado_remoto: confirmaExclusao ? 'excluido' : 'ativo' },
      });
    } catch (erro: unknown) {
      // O efeito já aconteceu; dizer "falhou" faria repeti-lo.
      registrarFalhaInterna('clientes.reativacao.auditoria', erro, { organizacaoId: scope.organizationId });
    }
    return responder({ resultado: confirmaExclusao ? 'ExclusionConfirmed' : 'Reactivated' });
  };
}
