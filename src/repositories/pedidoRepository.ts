import { supabaseServer } from '../lib/supabaseServer';
import { Pedido, ItemPedido, Nfe, Cliente } from '../types';
import { clienteRepository } from './clienteRepository';

// Tipo enriquecido para visualização no dashboard
export interface PedidoEnriquecido extends Pedido {
  cliente?: Cliente;
  itens?: ItemPedido[];
  nfe?: Nfe;
}

export class PedidoRepository {
  async getAllEnriched(userId: string): Promise<PedidoEnriquecido[]> {
    try {
      const { data, error } = await supabaseServer
        .from('pedidos')
        .select(`
          *,
          cliente:clientes!fk_pedido_cliente(*),
          nfe:nfes(*)
        `)
        .eq('user_id', userId)
        .order('data', { ascending: false });

      if (!error && data) {
        return data;
      }
    } catch (e: any) {
      console.warn('⚠️ Alerta: Busca de pedidos com join explícito falhou, tentando fallback simples:', e.message);
    }

    // Fallback caso a relação PostgREST apresente duplicidade de FK
    try {
      const { data: rawPedidos, error: pErr } = await supabaseServer
        .from('pedidos')
        .select('*, nfe:nfes(*)')
        .eq('user_id', userId)
        .order('data', { ascending: false });

      if (pErr) throw pErr;

      const clientes = await clienteRepository.getAll(userId);
      const clienteMap = new Map(clientes.map(c => [c.id, c]));

      return (rawPedidos || []).map(p => ({
        ...p,
        cliente: clienteMap.get(p.cliente_id)
      }));
    } catch (err: any) {
      console.error('Erro ao buscar pedidos no fallback:', err);
      return [];
    }
  }

  async getById(userId: string, id: string): Promise<Pedido | null> {
    const { data, error } = await supabaseServer
      .from('pedidos')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .maybeSingle();

    if (error) {
      console.error(`Erro ao buscar pedido por ID ${id} no Supabase:`, error);
      throw error;
    }
    return data || null;
  }

  async getByBlingId(userId: string, blingId: string): Promise<Pedido | null> {
    const { data, error } = await supabaseServer
      .from('pedidos')
      .select('*')
      .eq('user_id', userId)
      .eq('bling_id', blingId)
      .maybeSingle();

    if (error) {
      console.error(`Erro ao buscar pedido por Bling ID ${blingId} no Supabase:`, error);
      throw error;
    }
    return data || null;
  }

  async upsert(userId: string, pedido: Pedido): Promise<Pedido> {
    const payload = { ...pedido, user_id: userId };
    const { data, error } = await supabaseServer
      .from('pedidos')
      .upsert(payload, { onConflict: 'user_id, bling_id' })
      .select()
      .single();

    if (error) {
      console.error('Erro ao persistir pedido no Supabase:', error);
      throw error;
    }
    return data;
  }

  // Operações para Itens de Pedido
  async addItems(userId: string, items: ItemPedido[]): Promise<void> {
    const itemsWithUser = items.map(i => ({ ...i, user_id: userId }));
    // Utiliza upsert composto (pedido_id, produto_id) para garantir idempotência (CT-001)
    const { error } = await supabaseServer
      .from('itens_pedido')
      .upsert(itemsWithUser, { onConflict: 'pedido_id,produto_id' });

    if (error) {
      console.error('Erro ao salvar itens de pedido no Supabase:', error);
      throw error;
    }
  }

  // Operações para NF-es
  async upsertNfe(userId: string, nfe: Nfe): Promise<Nfe> {
    const payload = { ...nfe, user_id: userId };
    const { data, error } = await supabaseServer
      .from('nfes')
      .upsert(payload, { onConflict: 'user_id, bling_id' })
      .select()
      .single();

    if (error) {
      console.error('Erro ao persistir NF-e no Supabase:', error);
      throw error;
    }
    return data;
  }

  // Obter faturamento mensal total
  async getFaturamentoMensal(userId: string): Promise<number> {
    const pedidos = await this.getAllEnriched(userId);
    const trintaDiasAtras = Date.now() - 30 * 24 * 60 * 60 * 1000;
    
    return pedidos
      .filter(p => p.status !== 'Cancelado' && new Date(p.data).getTime() >= trintaDiasAtras)
      .reduce((acc, current) => acc + Number(current.total), 0);
  }

  async getDashboardStats(userId: string): Promise<{ faturamento30: number; total: number; pendentes: number; cancelados: number; atendidos: number }> {
    try {
      const { data, error } = await supabaseServer.rpc('dashboard_stats', { p_user_id: userId }).maybeSingle();
      if (!error && data) {
        const d = data as any;
        return {
          faturamento30: Number(d.faturamento30) || 0,
          total: Number(d.total) || 0,
          pendentes: Number(d.pendentes) || 0,
          cancelados: Number(d.cancelados) || 0,
          atendidos: Number(d.atendidos) || 0,
        };
      }
    } catch (e) {
      console.warn('Alerta: rpc dashboard_stats falhou.', e);
    }
    
    return { faturamento30: 0, total: 0, pendentes: 0, cancelados: 0, atendidos: 0 };
  }
}

export const pedidoRepository = new PedidoRepository();


