/**
 * dbAdapter.ts
 * Ticket 17: adapter do sistema "banco" — a fonte de dados que a própria
 * ORBITA controla diretamente (`clientes`, `pedidos`, `itens_pedido`,
 * `financeiro`, `produtos`, `membros_organizacao`).
 *
 * A decisão de negócio (completed/not_found/retained_with_reason) é uma
 * função pura testável sem banco; a busca/gravação real vive na classe
 * `SupabaseDbAdapter`, que só traduz port -> Supabase (mesmo padrão de
 * `clienteRepository.ts`, não teste unitário direto — comportamento
 * coberto pelo pgTAP e pelo trigger `fn_validar_exclusao_cliente` já
 * existente no schema).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { AdapterOutcome, DireitoTipo, TitularSystemAdapter, TitularTaskContext } from './types';

export interface ClienteRow {
  readonly id: string;
  readonly nome: string;
  readonly email: string | null;
  readonly telefone: string | null;
  readonly cpf_cnpj: string | null;
}

export interface PedidoRow {
  readonly id: string;
  readonly numero: string;
  readonly data: string;
  readonly total: number;
  readonly status: string;
}

/** Porta mínima de acesso a dados para o adapter "banco" — permite testar a
 * decisão de negócio com um fake escrito à mão (sem `vi.mock`). */
export interface TitularDatabasePort {
  findCliente(organizationId: string, clienteId: string): Promise<ClienteRow | null>;
  findPedidosByCliente(organizationId: string, clienteId: string): Promise<PedidoRow[]>;
  anonymizeCliente(organizationId: string, clienteId: string): Promise<{ readonly blockedByPedidos: boolean }>;
  updateClienteFields(
    organizationId: string,
    clienteId: string,
    changes: Readonly<Record<string, unknown>>,
  ): Promise<boolean>;
  findMembership(organizationId: string, userId: string): Promise<{ readonly papel: string } | null>;
}

/** Campos aceitáveis para correção pelo próprio titular via este adapter.
 * Nunca aceita `organizacao_id`/`id`/`bling_id` — esses nunca são "dados
 * pessoais corrigíveis pelo titular". */
const CORRECTABLE_CLIENTE_FIELDS: ReadonlySet<string> = new Set(['nome', 'email', 'telefone', 'cpf_cnpj']);

export function sanitizeCorrectionChanges(
  changes: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> {
  if (!changes) return {};
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(changes)) {
    if (CORRECTABLE_CLIENTE_FIELDS.has(key) && typeof value === 'string') {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

export class DbAdapter implements TitularSystemAdapter {
  readonly sistema = 'banco' as const;

  constructor(private readonly port: TitularDatabasePort) {}

  async execute(
    direito: DireitoTipo,
    context: TitularTaskContext,
    changes?: Readonly<Record<string, unknown>>,
  ): Promise<AdapterOutcome> {
    if (context.titularTipo === 'cliente_final') {
      return this.executeForCliente(direito, context, changes);
    }
    return this.executeForLojistaUser(direito, context);
  }

  private async executeForCliente(
    direito: DireitoTipo,
    context: TitularTaskContext,
    changes?: Readonly<Record<string, unknown>>,
  ): Promise<AdapterOutcome> {
    const clienteId = context.titularRefClienteId;
    if (!clienteId) return { status: 'failed', erro: 'titularRefClienteId ausente para titular cliente_final' };

    const cliente = await this.port.findCliente(context.organizationId, clienteId);
    if (!cliente) return { status: 'not_found' };

    if (direito === 'acesso' || direito === 'exportacao') {
      const pedidos = await this.port.findPedidosByCliente(context.organizationId, clienteId);
      return {
        status: 'completed',
        data: {
          cliente: { nome: cliente.nome, email: cliente.email, telefone: cliente.telefone, cpf_cnpj: cliente.cpf_cnpj },
          pedidos: pedidos.map((p) => ({ id: p.id, numero: p.numero, data: p.data, total: p.total, status: p.status })),
        },
      };
    }

    if (direito === 'correcao') {
      const sanitized = sanitizeCorrectionChanges(changes);
      if (Object.keys(sanitized).length === 0) {
        return { status: 'failed', erro: 'Nenhum campo corrigível informado para o cliente.' };
      }
      const applied = await this.port.updateClienteFields(context.organizationId, clienteId, sanitized);
      return applied ? { status: 'completed' } : { status: 'not_found' };
    }

    // exclusao: o trigger fn_validar_exclusao_cliente (schema_master.sql) já
    // impede DELETE físico quando existem pedidos vinculados (retenção
    // fiscal/contábil). A anonimização é a operação tecnicamente correta:
    // nunca promete eliminação de dado sob retenção obrigatória.
    const result = await this.port.anonymizeCliente(context.organizationId, clienteId);
    if (result.blockedByPedidos) {
      return {
        status: 'retained_with_reason',
        fundamento: 'retencao_fiscal_pedidos_vinculados',
      };
    }
    return { status: 'completed' };
  }

  private async executeForLojistaUser(direito: DireitoTipo, context: TitularTaskContext): Promise<AdapterOutcome> {
    const userId = context.titularRefUserId;
    if (!userId) return { status: 'failed', erro: 'titularRefUserId ausente para titular lojista_user' };

    const membership = await this.port.findMembership(context.organizationId, userId);
    if (!membership) return { status: 'not_found' };

    if (direito === 'acesso' || direito === 'exportacao') {
      return { status: 'completed', data: { papel: membership.papel } };
    }

    if (direito === 'correcao') {
      // Perfil/e-mail do lojista_user é gerido pelo próprio Supabase Auth
      // (fora do domínio de dados desta migration); este adapter não
      // corrige `membros_organizacao.papel` a pedido do próprio titular
      // (papel é decisão de governança da organização, não dado pessoal
      // autocorrigível).
      return { status: 'failed', erro: 'Correção de papel de organização não é uma operação de titular.' };
    }

    // exclusao de um lojista_user é o ciclo de vida de encerramento de
    // conta/organização já construído (migration 35 —
    // suspensao_retencao_encerramento); duplicar essa lógica aqui violaria
    // "não copiar código legado sem revisar autoridade". Ponto de extensão
    // needs-owner: religar este caminho ao fluxo de encerramento existente.
    return {
      status: 'retained_with_reason',
      fundamento: 'exclusao_de_conta_segue_fluxo_de_encerramento_existente_ticket_35',
    };
  }
}

/** Implementação real (Supabase, service role) da porta de banco. Não é
 * unitariamente testada aqui (thin passthrough, mesmo padrão de
 * `clienteRepository.ts`); a decisão de negócio testada é `DbAdapter`
 * acima, com um fake desta porta. */
export class SupabaseTitularDatabasePort implements TitularDatabasePort {
  constructor(private readonly supabase: SupabaseClient) {}

  async findCliente(organizationId: string, clienteId: string): Promise<ClienteRow | null> {
    const { data, error } = await this.supabase
      .from('clientes')
      .select('id, nome, email, telefone, cpf_cnpj')
      .eq('id', clienteId)
      .eq('organizacao_id', organizationId)
      .maybeSingle();
    if (error) throw new Error(`Falha ao buscar cliente: ${error.message}`);
    return data ?? null;
  }

  async findPedidosByCliente(organizationId: string, clienteId: string): Promise<PedidoRow[]> {
    const { data, error } = await this.supabase
      .from('pedidos')
      .select('id, numero, data, total, status')
      .eq('cliente_id', clienteId)
      .eq('organizacao_id', organizationId);
    if (error) throw new Error(`Falha ao buscar pedidos do cliente: ${error.message}`);
    return data ?? [];
  }

  async anonymizeCliente(organizationId: string, clienteId: string): Promise<{ readonly blockedByPedidos: boolean }> {
    const { count, error: countError } = await this.supabase
      .from('pedidos')
      .select('id', { count: 'exact', head: true })
      .eq('cliente_id', clienteId)
      .eq('organizacao_id', organizationId);
    if (countError) throw new Error(`Falha ao checar pedidos vinculados: ${countError.message}`);

    if ((count ?? 0) > 0) {
      // Anonimiza em vez de excluir: preserva a linha (obrigatória para o
      // FK de pedidos/nota fiscal) mas remove todo dado pessoal identificável.
      const { error } = await this.supabase
        .from('clientes')
        .update({ nome: '[titular removido]', email: null, telefone: null, cpf_cnpj: null })
        .eq('id', clienteId)
        .eq('organizacao_id', organizationId);
      if (error) throw new Error(`Falha ao anonimizar cliente: ${error.message}`);
      return { blockedByPedidos: true };
    }

    const { error } = await this.supabase
      .from('clientes')
      .delete()
      .eq('id', clienteId)
      .eq('organizacao_id', organizationId);
    if (error) throw new Error(`Falha ao excluir cliente: ${error.message}`);
    return { blockedByPedidos: false };
  }

  async updateClienteFields(
    organizationId: string,
    clienteId: string,
    changes: Readonly<Record<string, unknown>>,
  ): Promise<boolean> {
    const { data, error } = await this.supabase
      .from('clientes')
      .update(changes)
      .eq('id', clienteId)
      .eq('organizacao_id', organizationId)
      .select('id')
      .maybeSingle();
    if (error) throw new Error(`Falha ao corrigir dados do cliente: ${error.message}`);
    return Boolean(data);
  }

  async findMembership(organizationId: string, userId: string): Promise<{ readonly papel: string } | null> {
    const { data, error } = await this.supabase
      .from('membros_organizacao')
      .select('papel')
      .eq('organizacao_id', organizationId)
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw new Error(`Falha ao buscar membership: ${error.message}`);
    return data ?? null;
  }
}
