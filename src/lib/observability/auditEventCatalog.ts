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
  /** Proibidos além do padrão, para o que só este evento corre risco de carregar. */
  camposProibidosExtras?: readonly string[],
];

/**
 * A foto do produto passa por nome de arquivo, URL assinada, token de upload e
 * bytes — nenhum deles pode chegar à trilha, nem por engano de quem chama.
 */
const PROIBIDOS_DA_FOTO = [
  'url', 'signed_url', 'signedUrl', 'upload_token', 'uploadToken', 'caminho', 'path',
  'nome_arquivo', 'file_name', 'fileName', 'base64', 'bytes', 'conteudo', 'content',
  'corpo', 'body', 'resposta', 'response', 'link',
] as const;

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
  ['customer.contact_preserved_after_remote_removal', 'customers', 'warning', 'user', 1825, 'Contato já removido do Bling que ganhou histórico no ORBITA e foi preservado localmente.'],
  ['finance.entry_deleted', 'finance', 'warning', 'user', 1825, 'Lançamento de despesa puramente interno excluído por correção de entrada.'],
  ['finance.expense_cancelled', 'finance', 'warning', 'user', 1825, 'Despesa do Bling removida lá e mantida no histórico do ORBITA como cancelada.'],
  ['finance.remote_reconcile_required', 'finance', 'critical', 'user', 1825, 'Cancelamento de despesa sem confirmação do estado no Bling; nada local foi concluído.'],
  // Foto do produto (migration 71). Metadata: id do produto, se havia foto
  // anterior e o desfecho da limpeza — nunca nome do arquivo, URL, token ou bytes.
  ['catalog.product_image_uploaded', 'catalog', 'info', 'user', 730, 'Foto do produto adicionada ou trocada no ORBITA.', undefined, PROIBIDOS_DA_FOTO],
  ['catalog.product_image_removed', 'catalog', 'info', 'user', 730, 'Foto do produto removida no ORBITA; a imagem do Bling volta a ser exibida.', undefined, PROIBIDOS_DA_FOTO],
  // Sincronização da foto com o Bling (migration 72). Mesmas proibições: nada de
  // URL assinada, token, caminho ou corpo de resposta do Bling.
  ['catalog.product_image_bling_sync_pending', 'catalog', 'info', 'user', 730, 'Foto do produto salva no ORBITA aguardando sincronização com o Bling (produto sem vínculo).', undefined, PROIBIDOS_DA_FOTO],
  ['catalog.product_image_bling_synced', 'catalog', 'info', 'user', 730, 'Foto do produto convergida no Bling: exatamente a foto do ORBITA, ou nenhuma imagem.', undefined, PROIBIDOS_DA_FOTO],
  ['catalog.product_image_bling_sync_failed', 'catalog', 'warning', 'user', 730, 'Sincronização da foto do produto com o Bling não confirmada; estado continua pendente.', undefined, PROIBIDOS_DA_FOTO],
  // Cadastro de produto e sincronização de categorias (migration 79, PRE-006B).
  // Metadata: ids técnicos, operação, desfecho e contagens — nunca nome, SKU,
  // preço, descrição de categoria ou corpo do Bling.
  ['catalog.product_saved', 'catalog', 'info', 'user', 730, 'Produto cadastrado ou atualizado no Bling e espelhado no ORBITA.'],
  ['catalog.product_save_rejected', 'catalog', 'info', 'user', 730, 'O Bling recusou o cadastro ou a atualização do produto; nada foi gravado.'],
  ['catalog.product_reconcile_required', 'catalog', 'critical', 'user', 730, 'Gravação do produto sem confirmação do Bling, ou confirmada lá e não espelhada no ORBITA.'],
  ['catalog.categories_synced', 'catalog', 'info', 'user', 730, 'Categorias do Bling sincronizadas no ORBITA.'],
  ['catalog.categories_sync_failed', 'catalog', 'warning', 'user', 730, 'Sincronização de categorias interrompida; as páginas anteriores à falha ficaram gravadas.'],
  // Clientes e pedidos por comando autorizado (migration 80, PRE-006C).
  // Metadata: ids técnicos, operação, desfecho e contagens — nunca nome,
  // CPF/CNPJ, e-mail, telefone, mensagem ou corpo do Bling/Chatwoot.
  ['customer.contact_saved', 'customers', 'info', 'user', 1825, 'Contato cadastrado ou atualizado no Bling e espelhado no ORBITA.'],
  ['customer.contact_save_rejected', 'customers', 'info', 'user', 1825, 'O Bling recusou o cadastro ou a atualização do contato; nada foi gravado.'],
  ['customer.contact_save_reconcile_required', 'customers', 'critical', 'user', 1825, 'Gravação do contato sem confirmação do Bling, ou confirmada lá e não espelhada no ORBITA.'],
  ['customer.sac_contacts_registered', 'customers', 'info', 'user', 1825, 'Sincronização do SAC registrou clientes novos a partir de contatos do Chatwoot.'],
  ['order.status_changed', 'orders', 'info', 'user', 1825, 'Situação do pedido alterada no Bling e no ORBITA, com o desfecho do alinhamento de estoque.'],
  ['order.status_change_rejected', 'orders', 'info', 'user', 1825, 'O Bling recusou a mudança de situação do pedido; nada mudou.'],
  ['order.updated', 'orders', 'info', 'user', 1825, 'Pedido editado no Bling.'],
  ['order.deleted', 'orders', 'warning', 'user', 1825, 'Pedido apagado no Bling e no ORBITA.'],
  ['order.reconcile_required', 'orders', 'critical', 'user', 1825, 'Operação de pedido sem confirmação do Bling, ou confirmada lá e não refletida no ORBITA.'],
  ['order.manual_sale_recorded', 'orders', 'info', 'user', 1825, 'Venda manual registrada no Bling e no ORBITA.'],
  ['order.manual_sale_unresolved', 'orders', 'critical', 'user', 1825, 'Venda manual sem desfecho confirmado; tentativa bloqueada até a reconciliação.'],
  // NF-e emitida (migration 83, PRE-007B). Gravado pela RPC
  // `registrar_documento_fiscal_emitido` na mesma transação do documento.
  // Metadata: ids técnicos, situação e operação — nunca a chave de acesso,
  // destinatário, itens, valores ou corpo do Bling.
  ['fiscal.document_issued', 'fiscal', 'info', 'user', 1825, 'NF-e emitida no Bling e registrada no ORBITA.', undefined, ['chave_acesso', 'xml_url', 'danfe_url']],
  ['org.migration_readiness_failed', 'platform', 'critical', 'system', 400, 'Checagem de readiness/migration falhou (deploy potencialmente inseguro).', 'migrationReadiness'],
];

export const AUDIT_EVENT_CATALOG: readonly AuditEventDefinition[] = AUDIT_EVENT_ROWS.map(
  ([nome, produtor, severidade, atorEsperado, retentionDias, descricao, alertaRegra, camposProibidosExtras = []]) => ({
    nome,
    produtor,
    severidade,
    atorEsperado,
    retentionDias,
    descricao,
    alertaRegra,
    camposProibidos: [...CAMPOS_PROIBIDOS_PADRAO, ...camposProibidosExtras],
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
