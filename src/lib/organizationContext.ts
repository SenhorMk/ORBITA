import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';

export const papelMembroSchema = z.enum(['owner', 'admin', 'member']);
export type PapelMembro = z.infer<typeof papelMembroSchema>;

export const organizacaoSchema = z.object({
  id: z.string().uuid(),
  nome: z.string().min(2),
  slug: z.string().min(2),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Organizacao = z.infer<typeof organizacaoSchema>;

export const membroOrganizacaoSchema = z.object({
  id: z.string().uuid(),
  organizacao_id: z.string().uuid(),
  user_id: z.string().uuid(),
  papel: papelMembroSchema,
  created_at: z.string(),
  updated_at: z.string(),
});
export type MembroOrganizacao = z.infer<typeof membroOrganizacaoSchema>;

export const createOrgInputSchema = z.object({
  nome: z.string().trim().min(2, 'Nome deve ter no mínimo 2 caracteres'),
  slug: z.string().trim().min(2, 'Slug deve ter no mínimo 2 caracteres').regex(/^[a-zA-Z0-9_-]+$/, 'Slug inválido'),
});
export type CreateOrgInput = z.infer<typeof createOrgInputSchema>;

export const switchOrgInputSchema = z.object({
  organizacao_id: z.string().uuid('ID de organização inválido'),
  expected_version: z.number().int().nonnegative('Versão de organização ativa inválida'),
});
export type SwitchOrgInput = z.infer<typeof switchOrgInputSchema>;

/** Outcome of comparing the observed and current active organization. */
export const ACTIVE_ORG_COOKIE_NAME = 'orbita_active_org';

export interface ActiveOrganizationContext {
  readonly organizacao: Organizacao;
  readonly papel: PapelMembro;
}

/**
 * List all organizations the user belongs to.
 */
export async function listUserOrganizations(
  supabase: SupabaseClient,
  userId: string,
): Promise<readonly Organizacao[]> {
  const { data, error } = await supabase
    .from('membros_organizacao')
    .select('papel, organizacoes:organizacao_id (id, nome, slug, created_at, updated_at)')
    .eq('user_id', userId);

  if (error || !data) {
    return [];
  }

  const orgs: Organizacao[] = [];
  for (const item of data) {
    const rawOrg = Array.isArray(item.organizacoes) ? item.organizacoes[0] : item.organizacoes;
    const parsed = organizacaoSchema.safeParse(rawOrg);
    if (parsed.success) {
      orgs.push(parsed.data);
    }
  }

  return orgs;
}

/**
 * Resolve active organization for user.
 * If preferredOrgId is provided, validates user membership.
 * If not provided, selects the user's first persisted membership.
 * An explicit invalid/revoked preference fails closed and never falls back.
 */
export async function resolveActiveOrganization(
  supabase: SupabaseClient,
  userId: string,
  preferredOrgId?: string | null,
): Promise<ActiveOrganizationContext | null> {
  if (preferredOrgId) {
    const { data: memberData, error: memberError } = await supabase
      .from('membros_organizacao')
      .select('papel, organizacoes:organizacao_id (id, nome, slug, created_at, updated_at)')
      .eq('user_id', userId)
      .eq('organizacao_id', preferredOrgId)
      .maybeSingle();

    if (!memberError && memberData) {
      const rawOrg = Array.isArray(memberData.organizacoes) ? memberData.organizacoes[0] : memberData.organizacoes;
      const parsedOrg = organizacaoSchema.safeParse(rawOrg);
      const parsedPapel = papelMembroSchema.safeParse(memberData.papel);
      if (parsedOrg.success && parsedPapel.success) {
        return {
          organizacao: parsedOrg.data,
          papel: parsedPapel.data,
        };
      }
    }
    return null;
  }

  // Fallback to first membership
  const { data, error } = await supabase
    .from('membros_organizacao')
    .select('papel, organizacoes:organizacao_id (id, nome, slug, created_at, updated_at)')
    .eq('user_id', userId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error || !data) {
    return null;
  }

  const rawOrg = Array.isArray(data.organizacoes) ? data.organizacoes[0] : data.organizacoes;
  const parsedOrg = organizacaoSchema.safeParse(rawOrg);
  const parsedPapel = papelMembroSchema.safeParse(data.papel);

  if (!parsedOrg.success || !parsedPapel.success) {
    return null;
  }

  return {
    organizacao: parsedOrg.data,
    papel: parsedPapel.data,
  };
}

/**
 * Create an organization and owner membership atomically via RPC.
 */
export async function createOrganizationAtomic(
  supabase: SupabaseClient,
  input: CreateOrgInput,
): Promise<{ id: string; nome: string; slug: string }> {
  const validated = createOrgInputSchema.parse(input);

  const { data, error } = await supabase.rpc('criar_organizacao_atomica', {
    p_nome: validated.nome,
    p_slug: validated.slug,
  });

  if (error || !data) {
    throw new Error(error?.message || 'Falha ao criar organização');
  }

  return {
    id: data as string,
    nome: validated.nome,
    slug: validated.slug,
  };
}

/**
 * Resolve organizacao_id for a given VerifiedTenant or userId.
 */
export async function resolveTenantOrgId(
  supabase: SupabaseClient,
  tenant: { readonly id: string } | string,
): Promise<string> {
  const userId = typeof tenant === 'string' ? tenant : tenant.id;

  const { data } = await supabase
    .from('membros_organizacao')
    .select('organizacao_id')
    .eq('user_id', userId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  return data?.organizacao_id ?? userId;
}
