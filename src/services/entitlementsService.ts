/**
 * entitlementsService.ts
 * Planos, limites e entitlements.
 * Gerencia controle server-side de recursos, limites e planos da Organização.
 */

import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';

export const planSlugSchema = z.enum(['starter', 'pro', 'enterprise']);
export type PlanSlug = z.infer<typeof planSlugSchema>;

export const subscriptionStatusSchema = z.enum([
  'trial',
  'active',
  'past_due',
  'canceled',
  'incomplete',
]);
export type SubscriptionStatus = z.infer<typeof subscriptionStatusSchema>;

export const organizationEntitlementsSchema = z.object({
  organizacao_id: z.string().uuid(),
  plano_id: z.string().uuid(),
  plano_nome: z.string(),
  plano_slug: planSlugSchema,
  status: subscriptionStatusSchema,
  limite_membros: z.number().int().nonnegative(),
  limite_conexoes_bling: z.number().int().nonnegative(),
  limite_conexoes_chatwoot: z.number().int().nonnegative(),
  recursos: z.record(z.string(), z.boolean()).default({}),
  periodo_inicio: z.string(),
  periodo_fim: z.string().nullable().optional(),
});
export type OrganizationEntitlements = z.infer<typeof organizationEntitlementsSchema>;

export class EntitlementLimitExceededError extends Error {
  readonly code = 'ENTITLEMENT_LIMIT_EXCEEDED';
  readonly feature: string;
  readonly limit: number;
  readonly current: number;

  constructor(feature: string, limit: number, current: number, message?: string) {
    super(
      message ||
        `Limite de ${feature} atingido para o plano atual (${current}/${limit}). Faça upgrade para continuar.`,
    );
    this.name = 'EntitlementLimitExceededError';
    this.feature = feature;
    this.limit = limit;
    this.current = current;
  }
}

export class FeatureNotIncludedError extends Error {
  readonly code = 'FEATURE_NOT_INCLUDED';
  readonly feature: string;

  constructor(feature: string, message?: string) {
    super(
      message ||
        `O recurso "${feature}" não está disponível no plano atual. Faça upgrade para habilitá-lo.`,
    );
    this.name = 'FeatureNotIncludedError';
    this.feature = feature;
  }
}

/**
 * Obtém os entitlements e limites consolidados da organização via RPC ou fallback seguro.
 */
export async function getOrganizationEntitlements(
  supabase: SupabaseClient,
  orgId: string,
): Promise<OrganizationEntitlements> {
  const { data, error } = await supabase.rpc('obter_entitlements_organizacao', {
    p_org_id: orgId,
  });

  if (error || !data) {
    // Fallback defensivo para starter trial em caso de erro transitório de RPC
    return {
      organizacao_id: orgId,
      plano_id: '00000000-0000-0000-0000-000000000000',
      plano_nome: 'Starter',
      plano_slug: 'starter',
      status: 'trial',
      limite_membros: 3,
      limite_conexoes_bling: 1,
      limite_conexoes_chatwoot: 1,
      recursos: { export_relatorios: false, suporte_prioritario: false },
      periodo_inicio: new Date().toISOString(),
      periodo_fim: null,
    };
  }

  const parsed = organizationEntitlementsSchema.safeParse(data);
  if (!parsed.success) {
    return {
      organizacao_id: orgId,
      plano_id: data.plano_id || '00000000-0000-0000-0000-000000000000',
      plano_nome: data.plano_nome || 'Starter',
      plano_slug: 'starter',
      status: data.status || 'trial',
      limite_membros: data.limite_membros ?? 3,
      limite_conexoes_bling: data.limite_conexoes_bling ?? 1,
      limite_conexoes_chatwoot: data.limite_conexoes_chatwoot ?? 1,
      recursos: data.recursos ?? {},
      periodo_inicio: data.periodo_inicio || new Date().toISOString(),
      periodo_fim: data.periodo_fim ?? null,
    };
  }

  return parsed.data;
}

/**
 * Valida se a adição de um novo membro respeita o limite do plano.
 */
export async function enforceMemberLimit(
  supabase: SupabaseClient,
  orgId: string,
): Promise<void> {
  const entitlements = await getOrganizationEntitlements(supabase, orgId);

  // Contar membros ativos
  const { count: memberCount, error: memberErr } = await supabase
    .from('membros_organizacao')
    .select('*', { count: 'exact', head: true })
    .eq('organizacao_id', orgId);

  if (memberErr) {
    throw new Error(`Falha ao verificar contagem de membros: ${memberErr.message}`);
  }

  const currentCount = memberCount ?? 0;
  if (currentCount >= entitlements.limite_membros) {
    throw new EntitlementLimitExceededError(
      'membros',
      entitlements.limite_membros,
      currentCount,
    );
  }
}

/**
 * Valida se a adição de uma conexão de integração respeita o limite do plano.
 */
export async function enforceIntegrationLimit(
  supabase: SupabaseClient,
  orgId: string,
  provedor: 'bling' | 'chatwoot',
): Promise<void> {
  const entitlements = await getOrganizationEntitlements(supabase, orgId);
  const limit =
    provedor === 'bling'
      ? entitlements.limite_conexoes_bling
      : entitlements.limite_conexoes_chatwoot;

  const { count: connCount, error: connErr } = await supabase
    .from('conexoes_integracao')
    .select('*', { count: 'exact', head: true })
    .eq('organizacao_id', orgId)
    .eq('provedor', provedor)
    .eq('status', 'ativa');

  if (connErr) {
    throw new Error(`Falha ao verificar conexões de integração: ${connErr.message}`);
  }

  const currentCount = connCount ?? 0;
  if (currentCount >= limit) {
    throw new EntitlementLimitExceededError(
      `conexoes_${provedor}`,
      limit,
      currentCount,
      `Limite de conexões ${provedor.toUpperCase()} atingido para o plano ${entitlements.plano_nome} (${currentCount}/${limit}).`,
    );
  }
}

/**
 * Valida se um recurso booleano está habilitado no plano.
 */
export async function enforceFeatureAccess(
  supabase: SupabaseClient,
  orgId: string,
  feature: string,
): Promise<void> {
  const entitlements = await getOrganizationEntitlements(supabase, orgId);
  if (!entitlements.recursos[feature]) {
    throw new FeatureNotIncludedError(feature);
  }
}

/**
 * Atualiza o plano da organização e registra no histórico auditável.
 */
export async function updateOrganizationPlan(
  supabase: SupabaseClient,
  orgId: string,
  newPlanSlug: PlanSlug,
  motivo?: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  // Obter novo plano
  const { data: newPlan, error: planErr } = await supabase
    .from('planos')
    .select('id, nome, slug')
    .eq('slug', newPlanSlug)
    .single();

  if (planErr || !newPlan) {
    throw new Error(`Plano "${newPlanSlug}" não encontrado`);
  }

  // Obter assinatura atual
  const { data: currentSub } = await supabase
    .from('assinaturas_organizacao')
    .select('plano_id, status')
    .eq('organizacao_id', orgId)
    .maybeSingle();

  const previousPlanId = currentSub?.plano_id ?? null;
  let previousPlanSlug: PlanSlug | null = null;

  if (previousPlanId) {
    const { data: prevPlan } = await supabase
      .from('planos')
      .select('slug')
      .eq('id', previousPlanId)
      .maybeSingle();
    previousPlanSlug = (prevPlan?.slug as PlanSlug) ?? null;
  }

  const planRank: Record<PlanSlug, number> = { starter: 1, pro: 2, enterprise: 3 };
  const prevRank = previousPlanSlug ? (planRank[previousPlanSlug] ?? 1) : 0;
  const newRank = planRank[newPlanSlug] ?? 1;

  const eventName = previousPlanId
    ? newRank >= prevRank
      ? 'upgrade_plano'
      : 'downgrade_plano'
    : 'criacao_assinatura';

  // Atualizar ou inserir assinatura
  const { error: upsertErr } = await supabase
    .from('assinaturas_organizacao')
    .upsert(
      {
        organizacao_id: orgId,
        plano_id: newPlan.id,
        status: 'active',
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'organizacao_id' },
    );

  if (upsertErr) {
    throw new Error(`Falha ao atualizar assinatura da organização: ${upsertErr.message}`);
  }

  // Registrar histórico auditável
  await supabase.from('historico_entitlements').insert({
    organizacao_id: orgId,
    evento: eventName,
    plano_anterior_id: previousPlanId,
    novo_plano_id: newPlan.id,
    motivo: motivo || `Alteração para o plano ${newPlan.nome}`,
    metadata,
  });
}
