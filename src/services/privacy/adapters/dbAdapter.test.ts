import { describe, expect, it } from 'vitest';
import { DbAdapter, sanitizeCorrectionChanges, type ClienteRow, type PedidoRow, type TitularDatabasePort } from './dbAdapter';
import type { TitularTaskContext } from './types';

/** Fake escrito à mão (sem `vi.mock`) da porta de banco, para testar a
 * decisão de negócio do DbAdapter isoladamente do Supabase. */
class FakeTitularDatabasePort implements TitularDatabasePort {
  clientes = new Map<string, ClienteRow>();
  pedidosByCliente = new Map<string, PedidoRow[]>();
  memberships = new Map<string, { papel: string }>();
  blockedByPedidosOnAnonymize = false;
  updateShouldFindRow = true;

  async findCliente(_organizationId: string, clienteId: string) {
    return this.clientes.get(clienteId) ?? null;
  }
  async findPedidosByCliente(_organizationId: string, clienteId: string) {
    return this.pedidosByCliente.get(clienteId) ?? [];
  }
  async anonymizeCliente() {
    return { blockedByPedidos: this.blockedByPedidosOnAnonymize };
  }
  async updateClienteFields() {
    return this.updateShouldFindRow;
  }
  async findMembership(_organizationId: string, userId: string) {
    return this.memberships.get(userId) ?? null;
  }
}

function contextFor(overrides: Partial<TitularTaskContext> = {}): TitularTaskContext {
  return {
    organizationId: 'org-1',
    titularTipo: 'cliente_final',
    titularRefUserId: null,
    titularRefClienteId: 'cliente-1',
    solicitacaoId: 'req-1',
    correlationId: 'corr-1',
    ...overrides,
  };
}

describe('DbAdapter — cliente_final', () => {
  it('returns not_found for a cliente that does not exist in this organization', async () => {
    const port = new FakeTitularDatabasePort();
    const adapter = new DbAdapter(port);
    const outcome = await adapter.execute('acesso', contextFor());
    expect(outcome).toEqual({ status: 'not_found' });
  });

  it('exports cliente + pedidos data on acesso/exportacao, never secrets/internal fields', async () => {
    const port = new FakeTitularDatabasePort();
    port.clientes.set('cliente-1', {
      id: 'cliente-1',
      nome: 'Fulano',
      email: 'fulano@example.com',
      telefone: '11999999999',
      cpf_cnpj: '12345678900',
    });
    port.pedidosByCliente.set('cliente-1', [
      { id: 'pedido-1', numero: '1001', data: '2026-01-01', total: 199.9, status: 'Concluido' },
    ]);
    const adapter = new DbAdapter(port);
    const outcome = await adapter.execute('exportacao', contextFor());
    expect(outcome.status).toBe('completed');
    expect(outcome).toEqual({
      status: 'completed',
      data: {
        cliente: { nome: 'Fulano', email: 'fulano@example.com', telefone: '11999999999', cpf_cnpj: '12345678900' },
        pedidos: [{ id: 'pedido-1', numero: '1001', data: '2026-01-01', total: 199.9, status: 'Concluido' }],
      },
    });
  });

  it('correcao sanitizes non-correctable fields (never id/organizacao_id/bling_id)', () => {
    const sanitized = sanitizeCorrectionChanges({
      nome: 'Novo Nome',
      organizacao_id: 'attacker-org',
      id: 'attacker-id',
      bling_id: 'attacker-bling',
      email: 'novo@example.com',
    });
    expect(sanitized).toEqual({ nome: 'Novo Nome', email: 'novo@example.com' });
  });

  it('correcao fails cleanly when no correctable field is provided', async () => {
    const port = new FakeTitularDatabasePort();
    port.clientes.set('cliente-1', { id: 'cliente-1', nome: 'Fulano', email: null, telefone: null, cpf_cnpj: null });
    const adapter = new DbAdapter(port);
    const outcome = await adapter.execute('correcao', contextFor(), { organizacao_id: 'attacker' });
    expect(outcome.status).toBe('failed');
  });

  it('exclusao returns retained_with_reason when the cliente has linked pedidos (fiscal retention)', async () => {
    const port = new FakeTitularDatabasePort();
    port.clientes.set('cliente-1', { id: 'cliente-1', nome: 'Fulano', email: null, telefone: null, cpf_cnpj: null });
    port.blockedByPedidosOnAnonymize = true;
    const adapter = new DbAdapter(port);
    const outcome = await adapter.execute('exclusao', contextFor());
    expect(outcome).toEqual({ status: 'retained_with_reason', fundamento: 'retencao_fiscal_pedidos_vinculados' });
  });

  it('exclusao completes when the cliente has no linked pedidos', async () => {
    const port = new FakeTitularDatabasePort();
    port.clientes.set('cliente-1', { id: 'cliente-1', nome: 'Fulano', email: null, telefone: null, cpf_cnpj: null });
    port.blockedByPedidosOnAnonymize = false;
    const adapter = new DbAdapter(port);
    const outcome = await adapter.execute('exclusao', contextFor());
    expect(outcome).toEqual({ status: 'completed' });
  });
});

describe('DbAdapter — lojista_user', () => {
  it('returns not_found when the membership no longer exists', async () => {
    const port = new FakeTitularDatabasePort();
    const adapter = new DbAdapter(port);
    const outcome = await adapter.execute(
      'acesso',
      contextFor({ titularTipo: 'lojista_user', titularRefClienteId: null, titularRefUserId: 'user-1' }),
    );
    expect(outcome).toEqual({ status: 'not_found' });
  });

  it('exports membership role on acesso', async () => {
    const port = new FakeTitularDatabasePort();
    port.memberships.set('user-1', { papel: 'owner' });
    const adapter = new DbAdapter(port);
    const outcome = await adapter.execute(
      'acesso',
      contextFor({ titularTipo: 'lojista_user', titularRefClienteId: null, titularRefUserId: 'user-1' }),
    );
    expect(outcome).toEqual({ status: 'completed', data: { papel: 'owner' } });
  });

  it('exclusao of a lojista_user is retained_with_reason (delegates to the account-closure lifecycle)', async () => {
    const port = new FakeTitularDatabasePort();
    port.memberships.set('user-1', { papel: 'owner' });
    const adapter = new DbAdapter(port);
    const outcome = await adapter.execute(
      'exclusao',
      contextFor({ titularTipo: 'lojista_user', titularRefClienteId: null, titularRefUserId: 'user-1' }),
    );
    expect(outcome.status).toBe('retained_with_reason');
  });
});
