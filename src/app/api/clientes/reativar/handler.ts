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
 * `POST /api/clientes/reativar` — a reativação explícita de um contato
 * excluído no Bling (PRE-005). É o **único** caminho de volta: nenhum evento
 * do webhook nem a sincronização reativam sozinhos.
 *
 * 1. escopo verificado e `organization:manage` (quem pode); o banco confere o
 *    papel de novo;
 * 2. só o `blingId` vem do corpo, e só vale dentro da organização do escopo;
 * 3. sem exclusão vigente, nada a fazer (`NotExcluded`);
 * 4. o contato é **lido** no Bling: só um `200` com situação diferente de `E`
 *    prova que ele voltou. `404` ou `E` → `Blocked`; leitura sem prova →
 *    `ReconcileRequired`; recusa → `ProviderRefused`. Nada é reativado sem
 *    prova;
 * 5. só então `reativar_contato_excluido_no_bling`, que encerra a exclusão
 *    vigente (o registro fica, com quem e quando) e libera o contato local. Os
 *    dados dele voltam a ser atualizados pelo próximo evento ou sincronização.
 */

export interface ReativacaoDeContatoStorePort {
  exclusaoVigenteNoBling(scope: VerifiedOrganizationScope, blingId: string): Promise<boolean>;
  reativarExcluidoNoBling(scope: VerifiedOrganizationScope, blingId: string): Promise<'reativado' | 'nao_excluido' | 'negado'>;
}

export interface EventoDeReativacao {
  readonly acao: 'customer.contact_reactivated';
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

/** O que a leitura do Bling prova; só `Ativo` libera a reativação. */
function provaRemota(leitura: LeituraRemota<ContatoRemoto>): 'Ativo' | RespostaDaReativacao {
  switch (leitura._tag) {
    case 'RemotoAusente':
      return { resultado: 'Blocked', motivo: 'ainda_excluido_no_bling' };
    case 'RemotoRecusou':
      return { resultado: 'ProviderRefused', motivo: 'recusado_pelo_bling' };
    case 'RemotoLimitado':
      return { resultado: 'ProviderRefused', motivo: 'limite_de_requisicoes' };
    case 'RemotoIndeterminado':
      return { resultado: 'ReconcileRequired' };
    case 'RemotoPresente':
      if (leitura.valor.situacao === 'E') return { resultado: 'Blocked', motivo: 'ainda_excluido_no_bling' };
      // Sem a situação, a leitura não prova que o contato saiu da lixeira.
      return typeof leitura.valor.situacao === 'string' ? 'Ativo' : { resultado: 'ReconcileRequired' };
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

    if (!(await deps.store.exclusaoVigenteNoBling(scope, blingId))) return responder({ resultado: 'NotExcluded' });

    const prova = provaRemota(await deps.bling(scope).consultarContato(blingId));
    if (prova !== 'Ativo') {
      logger.warn('clientes.reativacao.recusada', { ...contexto, outcome: prova.resultado });
      return responder(prova);
    }

    const desfecho = await deps.store.reativarExcluidoNoBling(scope, blingId);
    if (desfecho === 'negado') return responder({ resultado: 'Forbidden' });
    if (desfecho === 'nao_excluido') return responder({ resultado: 'NotExcluded' });

    logger.info('clientes.reativacao.concluida', { ...contexto, outcome: 'reativado' });
    try {
      await deps.auditar(scope, {
        acao: 'customer.contact_reactivated',
        recurso: 'cliente',
        recursoId: blingId,
        correlationId,
        metadata: { bling_id: blingId, estado_remoto: 'ativo' },
      });
    } catch (erro: unknown) {
      // A reativação já aconteceu; dizer "falhou" faria repeti-la.
      registrarFalhaInterna('clientes.reativacao.auditoria', erro, { organizacaoId: scope.organizationId });
    }
    return responder({ resultado: 'Reactivated' });
  };
}
