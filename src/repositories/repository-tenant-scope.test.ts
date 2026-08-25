import { describe, expectTypeOf, it } from 'vitest';

import type { VerifiedTenant } from '../lib/auth';
import type { VerifiedOrganizationScope } from '../lib/verifiedOrganizationScope';
import type { ClienteRepository } from './clienteRepository';
import type { FinanceiroRepository } from './financeiroRepository';
import type { PedidoRepository } from './pedidoRepository';
import type { ProdutoRepository } from './produtoRepository';
import type { bling } from '../services/bling';
import type { IntegrationService } from '../services/integrationService';

describe('privileged repository tenant scope', () => {
  it('requires a previously verified tenant for every service-role adapter', () => {
    expectTypeOf<Parameters<ClienteRepository['getAll']>[0]>()
      .toEqualTypeOf<VerifiedTenant>();
    expectTypeOf<Parameters<FinanceiroRepository['getCategorias']>[0]>()
      .toEqualTypeOf<VerifiedTenant>();
    expectTypeOf<Parameters<PedidoRepository['getAllEnriched']>[0]>()
      .toEqualTypeOf<VerifiedTenant>();
    expectTypeOf<Parameters<PedidoRepository['deleteByBlingId']>[0]>()
      .toEqualTypeOf<VerifiedTenant>();
    expectTypeOf<Parameters<ProdutoRepository['getAll']>[0]>()
      .toEqualTypeOf<VerifiedTenant>();
    expectTypeOf<Parameters<typeof bling.forUser>[0]>()
      .toEqualTypeOf<VerifiedTenant>();
    expectTypeOf<Parameters<IntegrationService['linkSacToErp']>[0]>()
      .toEqualTypeOf<VerifiedOrganizationScope>();
  });

  it('requires a verified tenant for all FinanceiroRepository financial-domain operations', () => {
    // getCategoriaByBlingId: (tenant, blingId) — tenant must be VerifiedTenant
    expectTypeOf<Parameters<FinanceiroRepository['getCategoriaByBlingId']>[0]>()
      .toEqualTypeOf<VerifiedTenant>();
    // getResumo: (tenant) — tenant must be VerifiedTenant
    expectTypeOf<Parameters<FinanceiroRepository['getResumo']>[0]>()
      .toEqualTypeOf<VerifiedTenant>();
    // getTitulosFiltro: (tenant, filtros?) — tenant must be VerifiedTenant
    expectTypeOf<Parameters<FinanceiroRepository['getTitulosFiltro']>[0]>()
      .toEqualTypeOf<VerifiedTenant>();
    // upsertTitulo: (tenant, titulo) — tenant must be VerifiedTenant
    expectTypeOf<Parameters<FinanceiroRepository['upsertTitulo']>[0]>()
      .toEqualTypeOf<VerifiedTenant>();
  });
});
