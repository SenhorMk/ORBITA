import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { VerifiedTenant } from '../lib/auth';

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

import { clienteRepository } from './clienteRepository';
import { produtoRepository } from './produtoRepository';
import { pedidoRepository } from './pedidoRepository';
import { financeiroRepository } from './financeiroRepository';

const mockTenant = {
  id: USER_ID,
  organizacao_id: ORG_ID,
} as unknown as VerifiedTenant;

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveTenantOrgId.mockResolvedValue(ORG_ID);
});

describe('Ticket 36: Contração do Tenancy por Usuário em Repositórios', () => {
  describe('clienteRepository', () => {
    it('filtra getAll estritamente por organizacao_id', async () => {
      const selectMock = vi.fn().mockReturnThis();
      const eqMock = vi.fn().mockReturnThis();
      const orderMock = vi.fn().mockResolvedValueOnce({
        data: [{ id: 'cli-1', nome: 'Cliente A', organizacao_id: ORG_ID }],
        error: null,
      });

      mockFrom.mockReturnValueOnce({
        select: selectMock,
        eq: eqMock,
        order: orderMock,
      });

      const result = await clienteRepository.getAll(mockTenant);
      expect(result).toHaveLength(1);
      expect(mockFrom).toHaveBeenCalledWith('clientes');
      expect(eqMock).toHaveBeenCalledWith('organizacao_id', ORG_ID);
    });

    it('faz upsert usando onConflict com organizacao_id, bling_id', async () => {
      const upsertMock = vi.fn().mockReturnThis();
      const selectMock = vi.fn().mockReturnThis();
      const singleMock = vi.fn().mockResolvedValueOnce({
        data: { id: 'cli-1', nome: 'Cliente A', organizacao_id: ORG_ID, bling_id: '123' },
        error: null,
      });

      mockFrom.mockReturnValueOnce({
        upsert: upsertMock,
        select: selectMock,
        single: singleMock,
      });

      const result = await clienteRepository.upsert(mockTenant, {
        nome: 'Cliente A',
        bling_id: '123',
      });

      expect(result.id).toBe('cli-1');
      expect(upsertMock).toHaveBeenCalledWith(
        expect.objectContaining({
          organizacao_id: ORG_ID,
          user_id: USER_ID,
          bling_id: '123',
        }),
        { onConflict: 'organizacao_id, bling_id' },
      );
    });
  });

  describe('produtoRepository', () => {
    it('filtra getAll estritamente por organizacao_id', async () => {
      const selectMock = vi.fn().mockReturnThis();
      const eqMock = vi.fn().mockReturnThis();
      const orderMock = vi.fn().mockResolvedValueOnce({
        data: [{ id: 'prod-1', nome: 'Produto A', preco: 10, estoque: 5, organizacao_id: ORG_ID }],
        error: null,
      });

      mockFrom.mockReturnValueOnce({
        select: selectMock,
        eq: eqMock,
        order: orderMock,
      });

      const result = await produtoRepository.getAll(mockTenant);
      expect(result).toHaveLength(1);
      expect(mockFrom).toHaveBeenCalledWith('produtos');
      expect(eqMock).toHaveBeenCalledWith('organizacao_id', ORG_ID);
    });

    it('faz upsert usando onConflict com organizacao_id, bling_id', async () => {
      const upsertMock = vi.fn().mockReturnThis();
      const selectMock = vi.fn().mockReturnThis();
      const singleMock = vi.fn().mockResolvedValueOnce({
        data: { id: 'prod-1', nome: 'Produto A', preco: 10, estoque: 5, organizacao_id: ORG_ID, bling_id: '456' },
        error: null,
      });

      mockFrom.mockReturnValueOnce({
        upsert: upsertMock,
        select: selectMock,
        single: singleMock,
      });

      const result = await produtoRepository.upsert(mockTenant, {
        nome: 'Produto A',
        preco: 10,
        estoque: 5,
        bling_id: '456',
      });

      expect(result.id).toBe('prod-1');
      expect(upsertMock).toHaveBeenCalledWith(
        expect.objectContaining({
          organizacao_id: ORG_ID,
          user_id: USER_ID,
          bling_id: '456',
        }),
        { onConflict: 'organizacao_id, bling_id' },
      );
    });
  });

  describe('pedidoRepository', () => {
    it('filtra getByBlingId estritamente por organizacao_id', async () => {
      const selectMock = vi.fn().mockReturnThis();
      const eqMock = vi.fn().mockReturnThis();
      const maybeSingleMock = vi.fn().mockResolvedValueOnce({
        data: { id: 'ped-1', numero: '101', total: 100, organizacao_id: ORG_ID, bling_id: '789' },
        error: null,
      });

      mockFrom.mockReturnValueOnce({
        select: selectMock,
        eq: eqMock,
        maybeSingle: maybeSingleMock,
      });

      const result = await pedidoRepository.getByBlingId(mockTenant, '789');
      expect(result?.id).toBe('ped-1');
      expect(eqMock).toHaveBeenCalledWith('organizacao_id', ORG_ID);
      expect(eqMock).toHaveBeenCalledWith('bling_id', '789');
    });

    it('faz upsert usando onConflict com organizacao_id, bling_id', async () => {
      const upsertMock = vi.fn().mockReturnThis();
      const selectMock = vi.fn().mockReturnThis();
      const singleMock = vi.fn().mockResolvedValueOnce({
        data: { id: 'ped-1', numero: '101', total: 100, status: 'aprovado', cliente_id: 'cli-1', organizacao_id: ORG_ID, bling_id: '789' },
        error: null,
      });

      mockFrom.mockReturnValueOnce({
        upsert: upsertMock,
        select: selectMock,
        single: singleMock,
      });

      const result = await pedidoRepository.upsert(mockTenant, {
        numero: '101',
        data: '2026-08-20',
        total: 100,
        status: 'aprovado',
        cliente_id: 'cli-1',
        bling_id: '789',
      });

      expect(result.id).toBe('ped-1');
      expect(upsertMock).toHaveBeenCalledWith(
        expect.objectContaining({
          organizacao_id: ORG_ID,
          user_id: USER_ID,
          bling_id: '789',
        }),
        { onConflict: 'organizacao_id, bling_id' },
      );
    });
  });

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
