import { supabaseServer } from '../lib/supabaseServer';
import type { VerifiedOrganizationScope } from '../lib/verifiedOrganizationScope';
import { Cliente } from '../types';

export class ClienteRepository {
  async getAll(scope: VerifiedOrganizationScope): Promise<Cliente[]> {
    const { data, error } = await supabaseServer
      .from('clientes')
      .select('*')
      .eq('organizacao_id', scope.organizationId)
      .order('nome', { ascending: true });

    if (error) {
      console.error('Erro ao buscar clientes no Supabase:', error);
      throw error;
    }
    return data || [];
  }

  async getByBlingId(scope: VerifiedOrganizationScope, blingId: string): Promise<Cliente | null> {
    const { data, error } = await supabaseServer
      .from('clientes')
      .select('*')
      .eq('organizacao_id', scope.organizationId)
      .eq('bling_id', blingId)
      .maybeSingle();

    if (error) {
      console.error(`Erro ao buscar cliente por Bling ID ${blingId} no Supabase:`, error);
      throw error;
    }
    return data || null;
  }

  async upsert(scope: VerifiedOrganizationScope, cliente: Cliente): Promise<Cliente> {
    const payload: Record<string, unknown> = {
      ...cliente,
      organizacao_id: scope.organizationId,
      user_id: scope.actorId,
    };
    delete payload.telefone_normalizado;

    const { data, error } = await supabaseServer
      .from('clientes')
      .upsert(payload, { onConflict: 'organizacao_id, bling_id' })
      .select()
      .single();

    if (error) {
      console.error('Erro ao persistir cliente no Supabase:', error);
      throw error;
    }
    return data;
  }

  async delete(scope: VerifiedOrganizationScope, id: string): Promise<void> {
    const { error } = await supabaseServer
      .from('clientes')
      .delete()
      .eq('id', id)
      .eq('organizacao_id', scope.organizationId);

    if (error) {
      console.error('Erro ao excluir cliente no Supabase:', error);
      throw error;
    }
  }
}

export const clienteRepository = new ClienteRepository();
