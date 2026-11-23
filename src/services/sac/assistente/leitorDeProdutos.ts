import type { SupabaseClient } from '@supabase/supabase-js';
import type { LeitorDeProdutos, LinhaDeProduto } from './catalogo';

/**
 * Leitura do catálogo pelo worker (service role): o filtro por organização é
 * explícito porque o service role ignora RLS. Só colunas de vitrine; nenhuma
 * coluna de custo, fornecedor ou imagem.
 */
export function criarLeitorDeProdutos(banco: SupabaseClient): LeitorDeProdutos {
  return {
    async lerProdutos(organizacaoId) {
      const { data, error } = await banco.from('produtos')
        .select('nome, preco, estoque, estoque_reservado, situacao, arquivado_em, categoria:categorias!fk_produto_categoria_org(descricao)')
        .eq('organizacao_id', organizacaoId)
        .limit(500);
      if (error) throw new Error('Catálogo indisponível.');
      return (data ?? []) as unknown as LinhaDeProduto[];
    },
  };
}
