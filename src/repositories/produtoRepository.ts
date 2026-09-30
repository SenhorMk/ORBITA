import { supabaseServer } from '../lib/supabaseServer';
import type { VerifiedOrganizationScope } from '../lib/verifiedOrganizationScope';
import { Produto } from '../types';
import { descreverErro } from '../lib/erroLegivel';

export class ProdutoRepository {
  async getAll(scope: VerifiedOrganizationScope): Promise<Produto[]> {
    const { data, error } = await supabaseServer
      .from('produtos')
      .select('*')
      .eq('organizacao_id', scope.organizationId)
      .order('nome', { ascending: true });

    if (error) {
      console.error('Erro ao buscar produtos no Supabase:', error);
      throw error;
    }

    return data || [];
  }

  async getByBlingId(scope: VerifiedOrganizationScope, blingId: string): Promise<Produto | null> {
    const { data, error } = await supabaseServer
      .from('produtos')
      .select('*')
      .eq('organizacao_id', scope.organizationId)
      .eq('bling_id', blingId)
      .maybeSingle();

    if (error) {
      console.error(`Erro ao buscar produto por Bling ID ${blingId} no Supabase:`, error);
      throw error;
    }
    return data || null;
  }

  /**
   * Grava o produto espelhado do Bling ou editado no formulário.
   *
   * `imagem_storage_path` NUNCA sai daqui: é a foto escolhida no ORBITA, e este
   * é o caminho da sincronização e do webhook. Um `Produto` que chegasse com o
   * campo (lido de uma tela, por exemplo) sobrescreveria a escolha da pessoa.
   * Quem escreve a foto é só `ProdutoImagemRepository.trocarCaminho`.
   */
  async upsert(scope: VerifiedOrganizationScope, produto: Produto): Promise<Produto> {
    const payloadForUpsert = {
      ...produto,
      organizacao_id: scope.organizationId,
      user_id: scope.actorId,
    };
    delete payloadForUpsert.imagem_storage_path;

    if (produto.bling_id && produto.id) {
      const { data: existingBling } = await supabaseServer
        .from('produtos')
        .select('id')
        .eq('organizacao_id', scope.organizationId)
        .eq('bling_id', produto.bling_id)
        .maybeSingle();

      if (existingBling && existingBling.id !== produto.id) {
        try {
          await this.delete(scope, existingBling.id);
        } catch (delErr: unknown) {
          const errMsg = descreverErro(delErr);
          console.warn(`⚠️ Não foi possível deletar o duplicado: ${errMsg}`);
        }
      }
    }

    if (produto.id) {
      const { data, error: updateError } = await supabaseServer
        .from('produtos')
        .update(payloadForUpsert)
        .eq('id', produto.id)
        .eq('organizacao_id', scope.organizationId)
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

  async delete(scope: VerifiedOrganizationScope, id: string): Promise<void> {
    const { error } = await supabaseServer
      .from('produtos')
      .delete()
      .eq('id', id)
      .eq('organizacao_id', scope.organizationId);

    if (error) {
      console.error(`Erro ao deletar produto com id ${id} no Supabase:`, error);
      throw error;
    }
  }
}

export const produtoRepository = new ProdutoRepository();
