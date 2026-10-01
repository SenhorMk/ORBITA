import type { SupabaseClient } from '@supabase/supabase-js';

import type { VerifiedOrganizationScope } from '../lib/verifiedOrganizationScope';

/** O que as rotas de foto precisam do produto: nada além do dono e do estado da foto. */
export interface ProdutoComFoto {
  readonly id: string;
  /** A foto escolhida no ORBITA, ou `null`. */
  readonly imagemStoragePath: string | null;
  /** A imagem espelhada do Bling — o que volta a valer quando a foto sai. */
  readonly imagemDoBling: string | null;
}

/**
 * A única escrita de `produtos.imagem_storage_path`.
 *
 * O cliente é service-role e passa por cima da RLS: toda consulta filtra por
 * `id` **e** `organizacao_id` do escopo verificado. Um produto de outra
 * organização é indistinguível de um produto inexistente.
 */
export class ProdutoImagemRepository {
  constructor(private readonly db: SupabaseClient) {}

  async carregar(scope: VerifiedOrganizationScope, produtoId: string): Promise<ProdutoComFoto | null> {
    const { data, error } = await this.db
      .from('produtos')
      .select('id, imagem_storage_path, imagem_url')
      .eq('id', produtoId)
      .eq('organizacao_id', scope.organizationId)
      .maybeSingle();

    if (error) throw error;
    if (!data) return null;

    return {
      id: String(data.id),
      imagemStoragePath: typeof data.imagem_storage_path === 'string' ? data.imagem_storage_path : null,
      imagemDoBling: typeof data.imagem_url === 'string' && data.imagem_url.trim() ? data.imagem_url : null,
    };
  }

  /**
   * Compare-and-set do caminho da foto.
   *
   * Troca `anterior` por `novo` só se o banco ainda tiver `anterior`. O
   * `UPDATE ... WHERE imagem_storage_path = anterior` é atômico no Postgres:
   * duas trocas partindo do mesmo valor se serializam na trava da linha, e a
   * segunda reavalia o `WHERE` depois que a primeira commita — e não encontra
   * mais nada. `scripts/database-concurrency-foto-produto.mjs` prova isso com
   * duas transações reais.
   *
   * @returns `true` quando exatamente esta chamada fez a troca.
   */
  async trocarCaminho(
    scope: VerifiedOrganizationScope,
    produtoId: string,
    anterior: string | null,
    novo: string | null,
  ): Promise<boolean> {
    const alvo = this.db
      .from('produtos')
      .update({ imagem_storage_path: novo })
      .eq('id', produtoId)
      .eq('organizacao_id', scope.organizationId);
    const comPrecondicao = anterior === null
      ? alvo.is('imagem_storage_path', null)
      : alvo.eq('imagem_storage_path', anterior);

    const { data, error } = await comPrecondicao.select('id');
    if (error) throw error;
    return (data ?? []).length === 1;
  }
}
