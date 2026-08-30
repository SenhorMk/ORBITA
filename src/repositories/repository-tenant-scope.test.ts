import { describe, expectTypeOf, it } from 'vitest';

import type { VerifiedOrganizationScope } from '../lib/verifiedOrganizationScope';
import type { ClienteRepository } from './clienteRepository';
import type { FinanceiroRepository } from './financeiroRepository';
import type { PedidoRepository } from './pedidoRepository';
import type { ProdutoRepository } from './produtoRepository';
import type { bling } from '../services/bling';
import type { IntegrationService } from '../services/integrationService';

describe('privileged repository tenant scope', () => {
  it('requires a previously verified tenant for every service-role adapter', () => {
    // Ticket 08 (orbita-mvp-producao-v2): clienteRepository, produtoRepository and
    // pedidoRepository moved off the primitive VerifiedTenant/resolveTenantOrgId
    // fallback onto VerifiedOrganizationScope for the produto -> pedido manual ->
    // estoque -> fiscal vertical slice. bling.forUser still authenticates against
    // the Bling adapter's per-user credential storage (an external-provider
    // concern outside this ticket's DB-tenancy slice) and keeps VerifiedTenant.
    expectTypeOf<Parameters<ClienteRepository['getAll']>[0]>()
      .toEqualTypeOf<VerifiedOrganizationScope>();
    expectTypeOf<Parameters<FinanceiroRepository['getCategorias']>[0]>()
      .toEqualTypeOf<VerifiedOrganizationScope>();
    expectTypeOf<Parameters<PedidoRepository['getAllEnriched']>[0]>()
      .toEqualTypeOf<VerifiedOrganizationScope>();
    expectTypeOf<Parameters<PedidoRepository['deleteByBlingId']>[0]>()
      .toEqualTypeOf<VerifiedOrganizationScope>();
    expectTypeOf<Parameters<ProdutoRepository['getAll']>[0]>()
      .toEqualTypeOf<VerifiedOrganizationScope>();
    // Ticket 10b: o cliente do Bling passou a exigir a organizacao verificada.
    // Nao existe mais entrada por `VerifiedTenant` — a credencial vive no cofre
    // por organizacao, e `integracoes_bling` nao e legivel pelo `service_role`.
    expectTypeOf<Parameters<typeof bling.forVerifiedOrganization>[0]>()
      .toEqualTypeOf<VerifiedOrganizationScope>();
    expectTypeOf<Parameters<IntegrationService['linkSacToErp']>[0]>()
      .toEqualTypeOf<VerifiedOrganizationScope>();
  });

  it('requires a verified organization scope for all FinanceiroRepository financial-domain operations', () => {
    // Ticket 09 (orbita-mvp-producao-v2): financeiroRepository moved off the
    // primitive VerifiedTenant/resolveTenantOrgId fallback onto
    // VerifiedOrganizationScope, same as the ticket 08 slice.
    // getCategoriaByBlingId: (scope, blingId) — scope must be VerifiedOrganizationScope
    expectTypeOf<Parameters<FinanceiroRepository['getCategoriaByBlingId']>[0]>()
      .toEqualTypeOf<VerifiedOrganizationScope>();
    // getResumo: (scope) — scope must be VerifiedOrganizationScope
    expectTypeOf<Parameters<FinanceiroRepository['getResumo']>[0]>()
      .toEqualTypeOf<VerifiedOrganizationScope>();
    // getTitulosFiltro: (scope, filtros?) — scope must be VerifiedOrganizationScope
    expectTypeOf<Parameters<FinanceiroRepository['getTitulosFiltro']>[0]>()
      .toEqualTypeOf<VerifiedOrganizationScope>();
    // upsertTitulo: (scope, titulo) — scope must be VerifiedOrganizationScope
    expectTypeOf<Parameters<FinanceiroRepository['upsertTitulo']>[0]>()
      .toEqualTypeOf<VerifiedOrganizationScope>();
  });
});
