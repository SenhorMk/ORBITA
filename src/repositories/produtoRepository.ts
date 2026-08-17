import { supabaseServer } from '../lib/supabaseServer';
import type { VerifiedTenant } from '../lib/auth';
import { Produto } from '../types';
import { syncService } from '../services/sync';

export class ProdutoRepository {
  async getAll(tenant: VerifiedTenant): Promise<Produto[]> {
    const { data, error } = await supabaseServer
      .from('produtos')
      .select('*')
      .eq('user_id', tenant.id)
      .order('nome', { ascending: true });

    if (error) {
      console.error('Erro ao buscar produtos no Supabase:', error);
      throw error;
    }

    if (!data || data.length === 0) {
      console.log('📦 Nenhum produto encontrado no Supabase local. É recomendável rodar um Sync via painel.');
      return [];
    }

    return data || [];
  }

  async getByBlingId(tenant: VerifiedTenant, blingId: string): Promise<Produto | null> {
    const { data, error } = await supabaseServer
      .from('produtos')
      .select('*')
      .eq('user_id', tenant.id)
      .eq('bling_id', blingId)
      .maybeSingle();

    if (error) {
      console.error(`Erro ao buscar produto por Bling ID ${blingId} no Supabase:`, error);
      throw error;
    }
    return data || null;
  }

  async upsert(tenant: VerifiedTenant, produto: Produto): Promise<Produto> {
    const payloadForUpsert = { ...produto, user_id: tenant.id };

    if (produto.bling_id && produto.id) {
      const { data: existingBling } = await supabaseServer
        .from('produtos')
        .select('id')
        .eq('user_id', tenant.id)
        .eq('bling_id', produto.bling_id)
        .maybeSingle();

      if (existingBling && existingBling.id !== produto.id) {
        console.log(`⚠️ Resolvendo duplicidade: deletando registro duplicado puxado do Bling (${existingBling.id}) para manter o local (${produto.id})`);
        try {
          await this.delete(tenant, existingBling.id);
        } catch (delErr: any) {
          console.warn(`⚠️ Não foi possível deletar o duplicado (pode estar em uso): ${delErr.message}`);
        }
      }
    }

    if (produto.id) {
      // Se tem ID, faz um update explícito para não dar conflito de chave primária 
      // caso o bling_id tenha mudado (ex: passou de local para numérico)
      const { data, error: updateError } = await supabaseServer
        .from('produtos')
        .update(payloadForUpsert)
        .eq('id', produto.id)
        .eq('user_id', tenant.id)
        .select()
        .single();
        
      if (!updateError && data) {
        return data;
      }
      
      console.warn(`⚠️ Update falhou no Supabase para id ${produto.id}. Tentando upsert fallback... Erro:`, updateError?.message);
    }

    if (payloadForUpsert.id) {
      delete payloadForUpsert.id; // Remove ID to prevent "duplicate key value violates unique constraint 'produtos_pkey'" on upsert
    }

    const { data, error } = await supabaseServer
      .from('produtos')
      .upsert(payloadForUpsert, { onConflict: 'user_id, bling_id' })
      .select()
      .single();

    if (error) {
      console.error('Erro ao persistir produto no Supabase (upsert):', error);
      throw error;
    }
    return data;
  }

  async delete(tenant: VerifiedTenant, id: string): Promise<void> {
    const { error } = await supabaseServer
      .from('produtos')
      .delete()
      .eq('id', id)
      .eq('user_id', tenant.id);

    if (error) {
      console.error(`Erro ao deletar produto com id ${id} no Supabase:`, error);
      throw error;
    }
  }
}

export const produtoRepository = new ProdutoRepository();

