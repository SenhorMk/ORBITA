import { registrarFalhaInterna } from '../lib/observability/falhaInterna';
import type { VerifiedOrganizationScope } from '../lib/verifiedOrganizationScope';
import type { AuditEventInput } from './auditService';

/**
 * Um evento de auditoria das mutações comerciais (clientes, pedidos).
 *
 * Metadata só com ids técnicos, operação, desfecho e contagens: o catálogo
 * (`auditEventCatalog.ts`) recusa os campos proibidos, e `recordAuditEvent`
 * redige o resto.
 */
export interface EventoComercial {
  readonly acao: string;
  readonly recurso: string;
  readonly recursoId: string | null;
  readonly correlationId: string;
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
}

/**
 * Grava o evento e **nunca lança**. Quando chega aqui, o desfecho no Bling ou
 * no banco já está decidido: uma falha da trilha vai para o log técnico
 * redigido e não pode transformar um efeito confirmado numa falha
 * "reexecutável".
 */
export type AuditarComercial = (scope: VerifiedOrganizationScope, evento: EventoComercial) => Promise<void>;

/**
 * @param registrar - `recordAuditEvent(supabaseServer, …)` em produção: a RPC
 *   `registrar_evento_auditoria`, só `service_role`, reconfere a membership.
 */
export function criarAuditoriaComercial(
  registrar: (scope: VerifiedOrganizationScope, input: AuditEventInput) => Promise<unknown>,
): AuditarComercial {
  return async (scope, evento) => {
    try {
      await registrar(scope, {
        acao: evento.acao,
        recurso: evento.recurso,
        recursoId: evento.recursoId,
        correlationId: evento.correlationId,
        metadata: { ...evento.metadata },
      });
    } catch (erro: unknown) {
      registrarFalhaInterna(`auditoria.${evento.acao}`, erro, { organizacaoId: scope.organizationId, atorId: scope.actorId });
    }
  };
}
