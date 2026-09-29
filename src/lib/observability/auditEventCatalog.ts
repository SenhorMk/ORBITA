import { z } from 'zod';

/**
 * Catálogo versionado de eventos de auditoria.
 *
 * Cada linha declara: quem produz o evento, com qual severidade, qual tipo de ator é
 * esperado (humano autenticado vs. sistema/service-role), quais campos de metadata são
 * explicitamente proibidos (nunca devem ser gravados, mesmo redigidos — o chamador deve
 * omiti-los), por quanto tempo o evento deve ser retido e se existe uma regra de alerta
 * associada (`src/lib/observability/alerting.ts`).
 *
 * Bump `AUDIT_EVENT_CATALOG_VERSION` sempre que a forma de uma entrada mudar de modo
 * incompatível (não ao apenas adicionar um evento novo).
 */
export const AUDIT_EVENT_CATALOG_VERSION = 1;

export type AuditEventSeverity = 'info' | 'warning' | 'critical';
export type AuditEventActorType = 'user' | 'system';

export interface AuditEventDefinition {
  /** Nome estável no formato `familia.evento` (ex.: `auth.login_failed`). */
  readonly nome: string;
  /** Subsistema/serviço que produz o evento. */
  readonly produtor: string;
  readonly severidade: AuditEventSeverity;
  /** Tipo de ator esperado: `user` (ação humana autenticada) ou `system` (webhook/job/RPC). */
  readonly atorEsperado: AuditEventActorType;
  /** Campos de metadata que nunca podem ser gravados para este evento. */
  readonly camposProibidos: readonly string[];
  /** Dias de retenção da trilha para este evento antes de elegível a expurgo/anonimização. */
  readonly retentionDias: number;
  /** Nome da regra de alerta associada em `alerting.ts`, se houver. */
  readonly alertaRegra?: string;
  readonly descricao: string;
}

const CAMPOS_PROIBIDOS_PADRAO = [
  'password',
  'senha',
  'token',
  'access_token',
  'refresh_token',
  'secret',
  'client_secret',
  'authorization',
  'cookie',
  'cardNumber',
  'cvv',
  'cpf',
  'cnpj',
  'rawPayload',
] as const;

/**
 * Linha compacta do catálogo: [nome, produtor, severidade, atorEsperado, retentionDias,
 * descricao, alertaRegra?]. Tabela em vez de objetos repetidos — os campos são
 * homogêneos entre eventos, então a diferença de conteúdo fica mais fácil de revisar
 * linha a linha do que em blocos de objeto quase idênticos.
 */
type AuditEventRow = readonly [
  nome: string,
  produtor: string,
  severidade: AuditEventSeverity,
  atorEsperado: AuditEventActorType,
  retentionDias: number,
  descricao: string,
  alertaRegra?: string,
];

const AUDIT_EVENT_ROWS: readonly AuditEventRow[] = [
  ['auth.login_failed', 'auth', 'warning', 'user', 400, 'Tentativa de login com credenciais inválidas.', 'authFailureBurst'],
  ['auth.login_success', 'auth', 'info', 'user', 400, 'Login bem-sucedido de um usuário.'],
  ['auth.password_reset_requested', 'auth', 'info', 'user', 400, 'Solicitação de redefinição de senha.'],
  ['auth.api_key_created', 'auth', 'warning', 'user', 1825, 'Criação de uma nova chave de API.'],
  ['auth.session_revoked', 'auth', 'warning', 'system', 400, 'Sessão revogada por segurança (ex.: detecção de anomalia).'],

  ['membership.member_invited', 'organization', 'info', 'user', 730, 'Convite de novo membro para a organização.'],
  ['membership.member_removed', 'organization', 'warning', 'user', 730, 'Remoção de membro da organização.'],
  ['membership.role_changed', 'organization', 'warning', 'user', 730, 'Alteração de papel (role) de um membro.'],
  ['capability.granted', 'organization', 'warning', 'user', 730, 'Capacidade privilegiada concedida a um membro.'],
  ['capability.revoked', 'organization', 'info', 'user', 730, 'Capacidade privilegiada revogada de um membro.'],

  ['billing.owner_changed', 'billing', 'critical', 'user', 1825, 'Troca do titular (owner) da organização.', 'ownerOrBillingChange'],
  ['billing.plan_changed', 'billing', 'warning', 'user', 1825, 'Alteração de plano/assinatura da organização.', 'ownerOrBillingChange'],
  ['billing.payment_method_changed', 'billing', 'warning', 'user', 1825, 'Alteração do método de pagamento associado.', 'ownerOrBillingChange'],

  ['oauth.token_issued', 'integrations', 'info', 'system', 400, 'Token OAuth emitido/renovado para um provider externo.'],
  ['oauth.token_revoked', 'integrations', 'warning', 'system', 400, 'Token OAuth revogado ou expirado sem renovação.'],

  ['webhook.signature_invalid', 'integrations', 'critical', 'system', 400, 'Webhook recebido com assinatura inválida (possível forjamento).', 'invalidWebhookSignature'],
  ['webhook.replay_detected', 'integrations', 'warning', 'system', 400, 'Webhook duplicado detectado e descartado pela idempotência do inbox.'],

  ['job.dead_letter', 'jobs', 'critical', 'system', 400, 'Job/evento de outbox esgotou tentativas e foi movido para dead-letter.', 'deadLetter'],
  ['job.lease_expired_recovered', 'jobs', 'warning', 'system', 400, 'Lease de worker expirado recuperado pelo reaper.'],

  ['privacy.export_requested', 'privacy', 'info', 'user', 1825, 'Titular solicitou exportação dos próprios dados.'],
  ['privacy.export_completed', 'privacy', 'info', 'system', 1825, 'Exportação de dados do titular concluída.'],
  ['privacy.delete_requested', 'privacy', 'warning', 'user', 1825, 'Titular solicitou eliminação dos próprios dados.'],
  ['privacy.delete_completed', 'privacy', 'warning', 'system', 1825, 'Eliminação/anonimização de dados do titular concluída.'],

  ['security.cross_tenant_attempt', 'security', 'critical', 'system', 1825, 'Tentativa de acesso/gravação em organização diferente do escopo verificado.', 'crossTenantAttempt'],

  ['org.privileged_change', 'organization', 'warning', 'user', 1825, 'Alteração de configuração privilegiada da organização.'],

  // Correções operacionais (migration 69). Metadata só com ids técnicos e o
  // desfecho — nunca nome, documento, contato ou corpo do Bling.
  ['customer.contact_deleted', 'customers', 'warning', 'user', 1825, 'Contato sem histórico excluído no ORBITA e, quando vinculado, no Bling.'],
  ['customer.contact_reconcile_required', 'customers', 'critical', 'user', 1825, 'Exclusão de contato sem confirmação do estado no Bling; nada local foi concluído.'],
  ['finance.entry_deleted', 'finance', 'warning', 'user', 1825, 'Lançamento de despesa puramente interno excluído por correção de entrada.'],
  ['finance.expense_cancelled', 'finance', 'warning', 'user', 1825, 'Despesa do Bling removida lá e mantida no histórico do ORBITA como cancelada.'],
  ['finance.remote_reconcile_required', 'finance', 'critical', 'user', 1825, 'Cancelamento de despesa sem confirmação do estado no Bling; nada local foi concluído.'],
  ['org.migration_readiness_failed', 'platform', 'critical', 'system', 400, 'Checagem de readiness/migration falhou (deploy potencialmente inseguro).', 'migrationReadiness'],
];

export const AUDIT_EVENT_CATALOG: readonly AuditEventDefinition[] = AUDIT_EVENT_ROWS.map(
  ([nome, produtor, severidade, atorEsperado, retentionDias, descricao, alertaRegra]) => ({
    nome,
    produtor,
    severidade,
    atorEsperado,
    retentionDias,
    descricao,
    alertaRegra,
    camposProibidos: CAMPOS_PROIBIDOS_PADRAO,
  }),
);

const catalogByName = new Map(AUDIT_EVENT_CATALOG.map((e) => [e.nome, e]));

export function getAuditEventDefinition(nome: string): AuditEventDefinition | undefined {
  return catalogByName.get(nome);
}

export function isKnownAuditEvent(nome: string): boolean {
  return catalogByName.has(nome);
}

export type ValidateAuditEventResult =
  | { readonly _tag: 'Valid' }
  | { readonly _tag: 'UnknownEvent' }
  | { readonly _tag: 'ForbiddenField'; readonly field: string };

const metadataSchema = z.record(z.string(), z.unknown());

/**
 * Valida que `acao` pertence ao catálogo e que `metadata` não contém nenhum campo
 * explicitamente proibido para aquele evento. Não substitui `redactSensitiveData` — é
 * uma camada anterior que recusa o registro em vez de apenas mascarar o valor.
 */
export function validateAuditEventMetadata(
  acao: string,
  metadata: Record<string, unknown>,
): ValidateAuditEventResult {
  const def = getAuditEventDefinition(acao);
  if (!def) {
    return { _tag: 'UnknownEvent' };
  }

  const parsed = metadataSchema.safeParse(metadata);
  const safeMetadata = parsed.success ? parsed.data : {};

  for (const key of Object.keys(safeMetadata)) {
    if (def.camposProibidos.some((forbidden) => forbidden.toLowerCase() === key.toLowerCase())) {
      return { _tag: 'ForbiddenField', field: key };
    }
  }

  return { _tag: 'Valid' };
}
