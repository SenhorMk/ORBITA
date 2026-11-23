import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { LeitorDeProdutos, LinhaDeProduto } from './catalogo';

/** Só colunas de vitrine; nenhuma coluna de custo, fornecedor ou imagem. */
const COLUNAS = 'nome, preco, estoque, estoque_reservado, situacao, arquivado_em, categoria:categorias!fk_produto_categoria_org(descricao)';

const Categoria = z.object({ descricao: z.string().nullable() });

/**
 * A linha como o PostgREST devolve. A relação com `categorias` é para-um
 * (FK composta), mas o cliente pode tipá-la como lista: aceita as duas
 * formas e fica com a primeira.
 */
const Linha = z.object({
  nome: z.string().nullable(),
  preco: z.union([z.number(), z.string()]).nullable(),
  estoque: z.number().int().nullable(),
  estoque_reservado: z.number().int().nullable(),
  situacao: z.string().nullable(),
  arquivado_em: z.string().nullable(),
  categoria: z.union([Categoria, z.array(Categoria)]).nullable().optional(),
}).transform((l): LinhaDeProduto => ({
  nome: l.nome,
  preco: l.preco,
  estoque: l.estoque,
  estoque_reservado: l.estoque_reservado,
  situacao: l.situacao,
  arquivado_em: l.arquivado_em,
  categoria: Array.isArray(l.categoria) ? (l.categoria[0] ?? null) : (l.categoria ?? null),
}));

/**
 * Leitura do catálogo pelo worker (service role): o filtro por organização é
 * explícito porque o service role ignora RLS. A resposta é validada; formato
 * inesperado vira "catálogo indisponível" (fail closed), nunca dado parcial.
 */
export function criarLeitorDeProdutos(banco: SupabaseClient): LeitorDeProdutos {
  return {
    async lerProdutos(organizacaoId) {
      const { data, error } = await banco.from('produtos')
        .select(COLUNAS)
        .eq('organizacao_id', organizacaoId)
        .limit(500);
      if (error) throw new Error('Catálogo indisponível.');
      const lidas = z.array(Linha).safeParse(data ?? []);
      if (!lidas.success) throw new Error('Catálogo indisponível.');
      return lidas.data;
    },
  };
}
