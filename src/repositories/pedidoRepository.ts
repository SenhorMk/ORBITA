import { supabaseServer } from '../lib/supabaseServer';
import type { VerifiedTenant } from '../lib/auth';
import { resolveTenantOrgId } from '../lib/organizationContext';
import { Pedido, ItemPedido, Nfe, Cliente } from '../types';
import { clienteRepository } from './clienteRepository';

// Tipo enriquecido para visualização no dashboard
export interface PedidoEnriquecido extends Pedido {
  cliente?: Cliente;
  itens?: ItemPedido[];
  nfe?: Nfe;
}

interface RawDocumentoFiscal {
  id?: string;
  organizacao_id?: string;
  user_id?: string;
  bling_id?: string;
  numero?: string;
  chave_acesso?: string;
  chave?: string;
  status?: string;
  pedido_id?: string;
  emitida_em?: string;
  created_at?: string;
  updated_at?: string;
}

function mapDocumentoToNfe(doc?: RawDocumentoFiscal | null): Nfe | undefined {
  if (!doc) return undefined;
  return {
    id: doc.id,
    organizacao_id: doc.organizacao_id,
    user_id: doc.user_id,
    bling_id: doc.bling_id || '',
    numero: doc.numero || '',
    chave: doc.chave_acesso || doc.chave || '',
    status: doc.status || 'Pendente',
    pedido_id: doc.pedido_id || '',
    emitida_em: doc.emitida_em,
    created_at: doc.created_at,
    updated_at: doc.updated_at,
  };
}

export class PedidoRepository {
  async getAllEnriched(tenant: VerifiedTenant): Promise<PedidoEnriquecido[]> {
    const orgId = await resolveTenantOrgId(supabaseServer, tenant);
    try {
      const { data, error } = await supabaseServer
        .from('pedidos')
        .select(`
          *,
          cliente:clientes!fk_pedido_cliente(*),
          nfe:documentos_fiscais(*)
        `)
        .eq('organizacao_id', orgId)
        .order('data', { ascending: false });

      if (!error && data) {
        return (data as PedidoEnriquecido[]).map((p) => ({
          ...p,
          nfe: Array.isArray(p.nfe) ? mapDocumentoToNfe(p.nfe[0]) : mapDocumentoToNfe(p.nfe),
        }));
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn('⚠️ Alerta: Busca de pedidos com join explícito falhou, tentando fallback simples:', msg);
    }

    try {
      const { data: rawPedidos, error: pErr } = await supabaseServer
        .from('pedidos')
        .select('*, nfe:documentos_fiscais(*)')
        .eq('organizacao_id', orgId)
        .order('data', { ascending: false });

      if (pErr) throw pErr;

      const clientes = await clienteRepository.getAll(tenant);
      const clienteMap = new Map(clientes.map((c) => [c.id, c]));

      return ((rawPedidos || []) as PedidoEnriquecido[]).map((p) => ({
        ...p,
        cliente: p.cliente_id ? clienteMap.get(p.cliente_id) : undefined,
        nfe: Array.isArray(p.nfe) ? mapDocumentoToNfe(p.nfe[0]) : mapDocumentoToNfe(p.nfe),
      }));
    } catch (err: unknown) {
      console.error('Erro ao buscar pedidos no fallback:', err);
      return [];
    }
  }

  async getById(tenant: VerifiedTenant, id: string): Promise<Pedido | null> {
    const orgId = await resolveTenantOrgId(supabaseServer, tenant);
    const { data, error } = await supabaseServer
      .from('pedidos')
      .select('*')
      .eq('id', id)
      .eq('organizacao_id', orgId)
      .maybeSingle();

    if (error) {
      console.error(`Erro ao buscar pedido por ID ${id} no Supabase:`, error);
      throw error;
    }
    return data || null;
  }

  async getByBlingId(tenant: VerifiedTenant, blingId: string): Promise<Pedido | null> {
    const orgId = await resolveTenantOrgId(supabaseServer, tenant);
    const { data, error } = await supabaseServer
      .from('pedidos')
      .select('*')
      .eq('organizacao_id', orgId)
      .eq('bling_id', blingId)
      .maybeSingle();

    if (error) {
      console.error(`Erro ao buscar pedido por Bling ID ${blingId} no Supabase:`, error);
      throw error;
    }
    return data || null;
  }

  /** Delete an order only inside the previously verified tenant organization boundary. */
  async deleteByBlingId(tenant: VerifiedTenant, blingId: string): Promise<void> {
    const orgId = await resolveTenantOrgId(supabaseServer, tenant);
    const { error } = await supabaseServer
      .from('pedidos')
      .delete()
      .eq('organizacao_id', orgId)
      .eq('bling_id', blingId);

    if (error) {
      console.error(`Erro ao apagar pedido por Bling ID ${blingId} no Supabase:`, error);
      throw error;
    }
  }

  async upsert(tenant: VerifiedTenant, pedido: Pedido): Promise<Pedido> {
    const orgId = await resolveTenantOrgId(supabaseServer, tenant);
    const payload = {
      ...pedido,
      organizacao_id: orgId,
      user_id: tenant.id,
    };
    const { data, error } = await supabaseServer
      .from('pedidos')
      .upsert(payload, { onConflict: 'organizacao_id, bling_id' })
      .select()
      .single();

    if (error) {
      console.error('Erro ao persistir pedido no Supabase:', error);
      throw error;
    }
    return data;
  }

  // Operações para Itens de Pedido
  async addItems(tenant: VerifiedTenant, items: ItemPedido[]): Promise<void> {
    const orgId = await resolveTenantOrgId(supabaseServer, tenant);
    const itemsWithOrg = items.map((i) => ({
      ...i,
      organizacao_id: orgId,
      user_id: tenant.id,
    }));
    const { error } = await supabaseServer
      .from('itens_pedido')
      .upsert(itemsWithOrg, { onConflict: 'pedido_id,produto_id' });

    if (error) {
      console.error('Erro ao salvar itens de pedido no Supabase:', error);
      throw error;
    }
  }

  // Operações para Documentos Fiscais (Canônico)
  async upsertNfe(tenant: VerifiedTenant, nfe: Nfe): Promise<Nfe> {
    const orgId = await resolveTenantOrgId(supabaseServer, tenant);
    const payload = {
      organizacao_id: orgId,
      user_id: tenant.id,
      bling_id: nfe.bling_id,
      numero: nfe.numero,
      chave_acesso: nfe.chave || null,
      status: nfe.status,
      pedido_id: nfe.pedido_id,
      tipo: 'NFE',
    };

    const { data, error } = await supabaseServer
      .from('documentos_fiscais')
      .upsert(payload, { onConflict: 'organizacao_id, bling_id' })
      .select()
      .single();

    if (error) {
      console.error('Erro ao persistir Documento Fiscal no Supabase:', error);
      throw error;
    }

    return {
      id: data.id,
      organizacao_id: data.organizacao_id,
      user_id: data.user_id,
      bling_id: data.bling_id,
      numero: data.numero,
      chave: data.chave_acesso || '',
      status: data.status,
      pedido_id: data.pedido_id,
      emitida_em: data.emitida_em,
      created_at: data.created_at,
      updated_at: data.updated_at,
    };
  }

  // Obter faturamento mensal total
  async getFaturamentoMensal(tenant: VerifiedTenant): Promise<number> {
    const pedidos = await this.getAllEnriched(tenant);
    const trintaDiasAtras = Date.now() - 30 * 24 * 60 * 60 * 1000;

    return pedidos
      .filter((p) => new Date(p.data).getTime() >= trintaDiasAtras)
      .reduce((acc, p) => acc + Number(p.total || 0), 0);
  }

  // Estatísticas para o Dashboard
  async getDashboardStats(tenant: VerifiedTenant): Promise<{
    faturamento30: number;
    total: number;
    pendentes: number;
    cancelados: number;
    atendidos: number;
  }> {
    const pedidos = await this.getAllEnriched(tenant);
    const trintaDiasAtras = Date.now() - 30 * 24 * 60 * 60 * 1000;

    let faturamento30 = 0;
    let pendentes = 0;
    let cancelados = 0;
    let atendidos = 0;

    for (const p of pedidos) {
      const valor = Number(p.total || 0);
      const dataTime = new Date(p.data).getTime();
      if (dataTime >= trintaDiasAtras) {
        faturamento30 += valor;
      }

      const st = (p.status || '').toLowerCase();
      if (st.includes('pend') || st.includes('aberto')) {
        pendentes++;
      } else if (st.includes('canc')) {
        cancelados++;
      } else if (st.includes('atend') || st.includes('fatur')) {
        atendidos++;
      }
    }

    return {
      faturamento30,
      total: pedidos.length,
      pendentes,
      cancelados,
      atendidos,
    };
  }
}

export const pedidoRepository = new PedidoRepository();
