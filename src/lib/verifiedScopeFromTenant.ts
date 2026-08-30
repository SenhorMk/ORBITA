import { resolveTenantOrgId } from './organizationContext';
import { supabaseServer } from './supabaseServer';
import { verifyOrganizationScope, type VerifiedOrganizationScope } from './verifiedOrganizationScope';
import type { VerifiedTenant } from './auth';

/**
 * Converte um `VerifiedTenant` de sessão no `VerifiedOrganizationScope`
 * correspondente, provado contra a associação persistida.
 *
 * Existe porque três adapters de provider (pedidos por id, sincronização de
 * categorias e fornecedores) recebem `tenant` na assinatura da porta, mas
 * precisam de uma organização verificada para falar com o Bling desde o
 * Ticket 10b. Antes cada um resolvia — ou não resolvia — do seu jeito; a
 * cópia que existia dentro de `api/bling/pedidos/[id]/route.ts` foi movida
 * para cá para que exista uma implementação só.
 *
 * A autoridade continua sendo a associação no banco: o id do tenant é
 * candidato, nunca prova.
 */
export async function toVerifiedOrganizationScope(tenant: VerifiedTenant): Promise<VerifiedOrganizationScope> {
  const organizationId = await resolveTenantOrgId(supabaseServer, tenant);
  const result = await verifyOrganizationScope(supabaseServer, {
    organizationId,
    actorId: tenant.id,
  });
  if (result._tag !== 'OrganizationScopeVerified') {
    throw new Error('Escopo organizacional não verificado.');
  }
  return result.scope;
}
