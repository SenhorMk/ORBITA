import { supabaseServer } from '../lib/supabaseServer';
import type { VerifiedTenant } from '../lib/auth';
import { Cliente } from '../types';

export class ClienteRepository {
  async getAll(tenant: VerifiedTenant): Promise<Cliente[]> {
    const { data, error } = await supabaseServer
      .from('clientes')
      .select('*')
      .eq('user_id', tenant.id)
      .order('nome', { ascending: true });

    if (error) {
      console.error('Erro ao buscar clientes no Supabase:', error);
      throw error;
    }
    return data || [];
  }

  async getByBlingId(tenant: VerifiedTenant, blingId: string): Promise<Cliente | null> {
    const { data, error } = await supabaseServer
      .from('clientes')
      .select('*')
      .eq('user_id', tenant.id)
      .eq('bling_id', blingId)
      .maybeSingle();

    if (error) {
      console.error(`Erro ao buscar cliente por Bling ID ${blingId} no Supabase:`, error);
      throw error;
    }
    return data || null;
  }

  async upsert(tenant: VerifiedTenant, cliente: Cliente): Promise<Cliente> {
    const payload: any = { ...cliente, user_id: tenant.id };
    delete payload.telefone_normalizado;

    const { data, error } = await supabaseServer
      .from('clientes')
      .upsert(payload, { onConflict: 'user_id, bling_id' })
      .select()
      .single();

    if (error) {
      console.error('Erro ao persistir cliente no Supabase:', error);
      throw error;
    }
    return data;
  }

  async delete(tenant: VerifiedTenant, id: string): Promise<void> {
    const { error } = await supabaseServer
      .from('clientes')
      .delete()
      .eq('id', id)
      .eq('user_id', tenant.id);

    if (error) {
      console.error('Erro ao excluir cliente no Supabase:', error);
      throw error;
    }
  }
}

export const clienteRepository = new ClienteRepository();

