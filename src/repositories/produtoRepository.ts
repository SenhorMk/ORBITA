import { supabaseServer } from '../lib/supabaseServer';
import type { VerifiedOrganizationScope } from '../lib/verifiedOrganizationScope';
import { Produto } from '../types';
import { descreverErro } from '../lib/erroLegivel';
import { logger } from '../lib/observability/logger';

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
        .select('id, imagem_storage_path')
        .eq('organizacao_id', scope.organizationId)
        .eq('bling_id', produto.bling_id)
        .maybeSingle();

      // Duplicado com foto do ORBITA NÃO é apagado aqui: apagar a linha
      // descartaria a foto em silêncio e deixaria o objeto órfão no bucket, e
      // este repositório não fala com o Storage. O fluxo segue pelo mesmo
      // caminho de quando a exclusão do duplicado falha: o `update` do produto
      // editado esbarra no único `(organizacao_id, bling_id)` e o `upsert` por
      // conflito grava os dados na linha que tem a foto — a foto sobrevive.
      if (existingBling && existingBling.id !== produto.id && existingBling.imagem_storage_path) {
        logger.warn('Duplicado com foto do ORBITA preservado na deduplicação por bling_id', {
          subsystem: 'database',
          organizacaoId: scope.organizationId,
          produtoPreservado: existingBling.id,
          produtoEditado: produto.id,
        });
      } else if (existingBling && existingBling.id !== produto.id) {
        try {
          const fotoDoExcluido = await this.delete(scope, existingBling.id);
          // Só acontece se uma foto for confirmada entre a leitura acima e a
          // exclusão. O objeto fica sem referência; o registro torna-o
          // localizável pelo prefixo `<organizacao>/<produto>/`.
          if (fotoDoExcluido !== null) {
            logger.warn('Foto do ORBITA ficou sem referência na deduplicação por bling_id', {
              subsystem: 'database',
              organizacaoId: scope.organizationId,
              produtoExcluido: existingBling.id,
            });
          }
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

  /**
   * Exclui o produto da organização do escopo.
   *
   * @returns O `imagem_storage_path` que a linha **excluída** tinha (lido pelo
   *   próprio `DELETE ... RETURNING`), ou `null` quando não havia foto ou
   *   nenhuma linha saiu. É o único caminho que a limpeza do Storage pode
   *   usar: vem do banco, depois da exclusão, e nunca do navegador.
   */
  async delete(scope: VerifiedOrganizationScope, id: string): Promise<string | null> {
    const { data, error } = await supabaseServer
      .from('produtos')
      .delete()
      .eq('id', id)
      .eq('organizacao_id', scope.organizationId)
      .select('imagem_storage_path');

    if (error) {
      console.error(`Erro ao deletar produto com id ${id} no Supabase:`, error);
      throw error;
    }
    const caminho = (data ?? [])[0]?.imagem_storage_path;
    return typeof caminho === 'string' && caminho.length > 0 ? caminho : null;
  }
}

export const produtoRepository = new ProdutoRepository();
