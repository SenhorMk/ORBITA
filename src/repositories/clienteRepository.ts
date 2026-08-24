import { supabaseServer } from '../lib/supabaseServer';
import type { VerifiedTenant } from '../lib/auth';
import { resolveTenantOrgId } from '../lib/organizationContext';
import { Cliente } from '../types';

export class ClienteRepository {
  async getAll(tenant: VerifiedTenant): Promise<Cliente[]> {
    const orgId = await resolveTenantOrgId(supabaseServer, tenant);
    const { data, error } = await supabaseServer
      .from('clientes')
      .select('*')
      .eq('organizacao_id', orgId)
      .order('nome', { ascending: true });

    if (error) {
      console.error('Erro ao buscar clientes no Supabase:', error);
      throw error;
    }
    return data || [];
  }

  async getByBlingId(tenant: VerifiedTenant, blingId: string): Promise<Cliente | null> {
    const orgId = await resolveTenantOrgId(supabaseServer, tenant);
    const { data, error } = await supabaseServer
      .from('clientes')
      .select('*')
      .eq('organizacao_id', orgId)
      .eq('bling_id', blingId)
      .maybeSingle();

    if (error) {
      console.error(`Erro ao buscar cliente por Bling ID ${blingId} no Supabase:`, error);
      throw error;
    }
    return data || null;
  }

  async upsert(tenant: VerifiedTenant, cliente: Cliente): Promise<Cliente> {
    const orgId = await resolveTenantOrgId(supabaseServer, tenant);
    const payload: Record<string, unknown> = {
      ...cliente,
      organizacao_id: orgId,
      user_id: tenant.id,
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

  async delete(tenant: VerifiedTenant, id: string): Promise<void> {
    const orgId = await resolveTenantOrgId(supabaseServer, tenant);
    const { error } = await supabaseServer
      .from('clientes')
      .delete()
      .eq('id', id)
      .eq('organizacao_id', orgId);

    if (error) {
      console.error('Erro ao excluir cliente no Supabase:', error);
      throw error;
    }
  }
}

export const clienteRepository = new ClienteRepository();
