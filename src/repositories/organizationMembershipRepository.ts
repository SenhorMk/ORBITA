import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

import {
  organizacaoSchema,
  papelMembroSchema,
} from '@/lib/organizationContext';
import type {
  MembershipLookupResult,
  OrganizationActorId,
  OrganizationId,
  OrganizationMembershipPort,
  OrganizationSelection,
  PersistedOrganizationMembership,
} from '@/lib/organizationAuthorization';

type MembershipRow = {
  readonly papel: unknown;
  readonly organizacao_id: unknown;
  readonly organizacoes: unknown;
};

const activeSelectionRowSchema = z.object({
  organizacao_id: z.string().uuid(),
  versao: z.number().int().positive(),
});

function parseMembershipRow(
  actorId: OrganizationActorId,
  row: MembershipRow,
  selectionVersion: number,
): PersistedOrganizationMembership | null {
  const role = papelMembroSchema.safeParse(row.papel);
  const organization = organizacaoSchema.safeParse(
    Array.isArray(row.organizacoes) ? row.organizacoes[0] : row.organizacoes,
  );
  if (!role.success || !organization.success || organization.data.id !== row.organizacao_id) return null;
  // SAFETY: organizacaoSchema parsed id as UUID and the equality check binds it to the persisted foreign key.
  const organizationId = organization.data.id as OrganizationId;
  return {
    actorId,
    organizationId,
    role: role.data,
    organization: organization.data,
    selectionVersion,
  };
}

/** Supabase adapter for persisted organization authorization memberships. */
export class SupabaseOrganizationMemberships implements OrganizationMembershipPort {
  /** Construct the adapter with a server-side Supabase client. */
  constructor(private readonly supabase: SupabaseClient) {}

  /**
   * Encontra o vínculo pedido e o devolve junto com a versão da seleção ativa.
   *
   * A seleção ativa é lida primeiro porque sua versão acompanha qualquer
   * resultado: é essa versão que a tela devolve na próxima troca, para o banco
   * conferir se nada mudou no meio (CAS). Com
   * `FirstMembership`, a organização ativa persistida tem precedência; sem ela,
   * vale o vínculo mais antigo. Linha que não passa no schema é tratada como
   * falha do banco (`MembershipStoreUnavailable`), não como ausência de vínculo.
   */
  async findMembership(
    actorId: OrganizationActorId,
    selection: OrganizationSelection,
  ): Promise<MembershipLookupResult> {
    try {
      const activeResult = await this.supabase
        .from('contextos_organizacao_ativos')
        .select('organizacao_id, versao')
        .eq('user_id', actorId)
        .maybeSingle();
      if (activeResult.error) {
        return { _tag: 'MembershipStoreUnavailable', cause: activeResult.error.code ?? 'active_context_query_failed' };
      }
      const parsedActive = activeSelectionRowSchema.safeParse(activeResult.data);
      if (activeResult.data && !parsedActive.success) {
        return { _tag: 'MembershipStoreUnavailable', cause: 'invalid_active_context_record' };
      }
      const persistedOrganizationId = parsedActive.success ? parsedActive.data.organizacao_id : null;
      const selectionVersion = parsedActive.success ? parsedActive.data.versao : 0;
      let query = this.supabase
        .from('membros_organizacao')
        .select('papel, organizacao_id, organizacoes:organizacao_id (id, nome, slug, created_at, updated_at)')
        .eq('user_id', actorId);
      if (selection._tag === 'ExactOrganization') {
        query = query.eq('organizacao_id', selection.organizationId);
      } else if (persistedOrganizationId) {
        query = query.eq('organizacao_id', persistedOrganizationId);
      } else {
        query = query.order('created_at', { ascending: true }).limit(1);
      }
      const { data, error } = await query.maybeSingle();
      if (error) return { _tag: 'MembershipStoreUnavailable', cause: error.code ?? 'membership_query_failed' };
      if (!data) return { _tag: 'MembershipNotFound' };
      const membership = parseMembershipRow(actorId, data, selectionVersion);
      return membership
        ? { _tag: 'MembershipFound', membership }
        : { _tag: 'MembershipStoreUnavailable', cause: 'invalid_membership_record' };
    } catch {
      return { _tag: 'MembershipStoreUnavailable', cause: 'membership_store_unreachable' };
    }
  }


  /**
   * Troca a organização ativa pela RPC `alternar_organizacao_ativa_cas`.
   *
   * Duas abas podem pedir a troca ao mesmo tempo. Por isso a troca leva a
   * versão que a tela leu, e a RPC só grava se essa versão ainda for a atual
   * (CAS). A conferência do vínculo e a comparação de versão acontecem dentro
   * da mesma chamada ao banco:
   * - versão esperada `0`: só cria a seleção se ainda não existir nenhuma;
   * - versão esperada `n`: só troca se a versão atual ainda for `n`, e então a
   *   versão passa a `n + 1`.
   *
   * Resultados: sem vínculo com a organização (`42501`) → `Denied`; versão que
   * já não é a atual → `Stale` (outra aba trocou antes); sucesso → `Applied`,
   * com a nova versão.
   *
   * A GARANTIA REAL ESTÁ NO BANCO: a RPC (uma função executada dentro do
   * Postgres, definida na migration 38) confere e grava. Este adapter só a chama
   * e traduz a resposta.
   */
  async switchActiveOrganization(
    actorId: OrganizationActorId,
    organizationId: OrganizationId,
    expectedVersion: number,
  ): Promise<import('@/lib/organizationAuthorization').OrganizationSwitchResult> {
    try {
      const { data, error } = await this.supabase.rpc('alternar_organizacao_ativa_cas', {
        p_user_id: actorId,
        p_organizacao_id: organizationId,
        p_versao_esperada: expectedVersion,
      });
      if (error) {
        if (error.code === '42501') return { _tag: 'OrganizationSwitchDenied' };
        return { _tag: 'MembershipStoreUnavailable', cause: error.code ?? 'active_context_switch_failed' };
      }
      const row = Array.isArray(data) ? data[0] : data;
      if (!row || row.aplicado !== true || !Number.isSafeInteger(row.versao)) {
        return { _tag: 'OrganizationSwitchStale' };
      }
      return { _tag: 'OrganizationSwitchApplied', version: row.versao };
    } catch {
      return { _tag: 'MembershipStoreUnavailable', cause: 'membership_store_unreachable' };
    }
  }
}
