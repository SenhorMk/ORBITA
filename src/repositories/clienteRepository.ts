import { supabaseServer } from '../lib/supabaseServer';
import { Cliente } from '../types';

export class ClienteRepository {
  async getAll(userId: string): Promise<Cliente[]> {
    const { data, error } = await supabaseServer
      .from('clientes')
      .select('*')
      .eq('user_id', userId)
      .order('nome', { ascending: true });

    if (error) {
      console.error('Erro ao buscar clientes no Supabase:', error);
      throw error;
    }
    return data || [];
  }

  async getByBlingId(userId: string, blingId: string): Promise<Cliente | null> {
    const { data, error } = await supabaseServer
      .from('clientes')
      .select('*')
      .eq('user_id', userId)
      .eq('bling_id', blingId)
      .maybeSingle();

    if (error) {
      console.error(`Erro ao buscar cliente por Bling ID ${blingId} no Supabase:`, error);
      throw error;
    }
    return data || null;
  }

  async upsert(userId: string, cliente: Cliente): Promise<Cliente> {
    const payload: any = { ...cliente, user_id: userId };
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

  async delete(userId: string, id: string): Promise<void> {
    const { error } = await supabaseServer
      .from('clientes')
      .delete()
      .eq('id', id)
      .eq('user_id', userId);

    if (error) {
      console.error('Erro ao excluir cliente no Supabase:', error);
      throw error;
    }
  }
}

export const clienteRepository = new ClienteRepository();

