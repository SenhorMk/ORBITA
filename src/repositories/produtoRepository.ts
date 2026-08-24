import { supabaseServer } from '../lib/supabaseServer';
import type { VerifiedTenant } from '../lib/auth';
import { resolveTenantOrgId } from '../lib/organizationContext';
import { Produto } from '../types';

export class ProdutoRepository {
  async getAll(tenant: VerifiedTenant): Promise<Produto[]> {
    const orgId = await resolveTenantOrgId(supabaseServer, tenant);
    const { data, error } = await supabaseServer
      .from('produtos')
      .select('*')
      .eq('organizacao_id', orgId)
      .order('nome', { ascending: true });

    if (error) {
      console.error('Erro ao buscar produtos no Supabase:', error);
      throw error;
    }

    return data || [];
  }

  async getByBlingId(tenant: VerifiedTenant, blingId: string): Promise<Produto | null> {
    const orgId = await resolveTenantOrgId(supabaseServer, tenant);
    const { data, error } = await supabaseServer
      .from('produtos')
      .select('*')
      .eq('organizacao_id', orgId)
      .eq('bling_id', blingId)
      .maybeSingle();

    if (error) {
      console.error(`Erro ao buscar produto por Bling ID ${blingId} no Supabase:`, error);
      throw error;
    }
    return data || null;
  }

  async upsert(tenant: VerifiedTenant, produto: Produto): Promise<Produto> {
    const orgId = await resolveTenantOrgId(supabaseServer, tenant);
    const payloadForUpsert = {
      ...produto,
      organizacao_id: orgId,
      user_id: tenant.id,
    };

    if (produto.bling_id && produto.id) {
      const { data: existingBling } = await supabaseServer
        .from('produtos')
        .select('id')
        .eq('organizacao_id', orgId)
        .eq('bling_id', produto.bling_id)
        .maybeSingle();

      if (existingBling && existingBling.id !== produto.id) {
        try {
          await this.delete(tenant, existingBling.id);
        } catch (delErr: unknown) {
          const errMsg = delErr instanceof Error ? delErr.message : String(delErr);
          console.warn(`⚠️ Não foi possível deletar o duplicado: ${errMsg}`);
        }
      }
    }

    if (produto.id) {
      const { data, error: updateError } = await supabaseServer
        .from('produtos')
        .update(payloadForUpsert)
        .eq('id', produto.id)
        .eq('organizacao_id', orgId)
        .select()
        .single();

      if (!updateError && data) {
        return data;
      }
    }

    if (payloadForUpsert.id) {
      delete payloadForUpsert.id;
    }

    const { data, error } = await supabaseServer
      .from('produtos')
      .upsert(payloadForUpsert, { onConflict: 'organizacao_id, bling_id' })
      .select()
      .single();

    if (error) {
      console.error('Erro ao persistir produto no Supabase (upsert):', error);
      throw error;
    }
    return data;
  }

  async delete(tenant: VerifiedTenant, id: string): Promise<void> {
    const orgId = await resolveTenantOrgId(supabaseServer, tenant);
    const { error } = await supabaseServer
      .from('produtos')
      .delete()
      .eq('id', id)
      .eq('organizacao_id', orgId);

    if (error) {
      console.error(`Erro ao deletar produto com id ${id} no Supabase:`, error);
      throw error;
    }
  }
}

export const produtoRepository = new ProdutoRepository();
