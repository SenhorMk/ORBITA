import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { VerifiedTenant } from '../lib/auth';

// Ticket 08 (orbita-mvp-producao-v2) migrated clienteRepository, produtoRepository
// and pedidoRepository off resolveTenantOrgId/VerifiedTenant entirely: they now
// require a previously verified VerifiedOrganizationScope (see
// src/repositories/repository-tenant-scope.test.ts for the type-level contract,
// and supabase/tests/database/catalogo_comercial_estoque_fiscal_organizacao.test.sql
// for the real-database, no-mock cross-tenant proof). Module-mocking those
// repositories to assert resolveTenantOrgId behavior would reintroduce the
// primitive-tenant fallback contract this ticket removes, so their coverage was
// moved rather than mocked here. financeiroRepository is out of this ticket's
// vertical slice and keeps its existing VerifiedTenant-based contract.
const {
  ORG_ID,
  USER_ID,
  mockFrom,
  mockResolveTenantOrgId,
} = vi.hoisted(() => {
  const ORG_ID = 'cccccccc-0000-0000-0000-000000000003';
  const USER_ID = 'dddddddd-0000-0000-0000-000000000004';

  return {
    ORG_ID,
    USER_ID,
    mockFrom: vi.fn(),
    mockResolveTenantOrgId: vi.fn(),
  };
});

vi.mock('../lib/supabaseServer', () => ({
  supabaseServer: {
    from: (...args: unknown[]) => mockFrom(...args),
  },
}));

vi.mock('../lib/organizationContext', () => ({
  resolveTenantOrgId: (...args: unknown[]) => mockResolveTenantOrgId(...args),
}));

import { financeiroRepository } from './financeiroRepository';

const mockTenant = {
  id: USER_ID,
  organizacao_id: ORG_ID,
} as unknown as VerifiedTenant;

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveTenantOrgId.mockResolvedValue(ORG_ID);
});

describe('Ticket 36: Contração do Tenancy por Usuário em Repositórios (financeiro, fora da fatia do ticket 08)', () => {
  describe('financeiroRepository', () => {
    it('filtra getCategorias estritamente por organizacao_id', async () => {
      const selectMock = vi.fn().mockReturnThis();
      const eqMock = vi.fn().mockReturnThis();
      const orderMock = vi.fn().mockResolvedValueOnce({
        data: [{ id: 'cat-1', descricao: 'Vendas', tipo: 'receita', organizacao_id: ORG_ID }],
        error: null,
      });

      mockFrom.mockReturnValueOnce({
        select: selectMock,
        eq: eqMock,
        order: orderMock,
      });

      const result = await financeiroRepository.getCategorias(mockTenant);
      expect(result).toHaveLength(1);
      expect(mockFrom).toHaveBeenCalledWith('categorias_financeiras');
      expect(eqMock).toHaveBeenCalledWith('organizacao_id', ORG_ID);
    });

    it('faz upsertTitulo usando onConflict com organizacao_id, bling_id', async () => {
      const upsertMock = vi.fn().mockReturnThis();
      const selectMock = vi.fn().mockReturnThis();
      const singleMock = vi.fn().mockResolvedValueOnce({
        data: { id: 'tit-1', valor: 50, tipo: 'receber', situacao: 'pago', organizacao_id: ORG_ID, bling_id: 999 },
        error: null,
      });

      mockFrom.mockReturnValueOnce({
        upsert: upsertMock,
        select: selectMock,
        single: singleMock,
      });

      const result = await financeiroRepository.upsertTitulo(mockTenant, {
        descricao: 'Venda de produtos',
        valor: 50,
        tipo: 'receber',
        situacao: 'pago',
        data_vencimento: '2026-08-20',
        bling_id: 999,
      });

      expect(result.id).toBe('tit-1');
      expect(upsertMock).toHaveBeenCalledWith(
        expect.objectContaining({
          organizacao_id: ORG_ID,
          user_id: USER_ID,
          bling_id: 999,
        }),
        { onConflict: 'organizacao_id, bling_id', ignoreDuplicates: false },
      );
    });
  });
});
