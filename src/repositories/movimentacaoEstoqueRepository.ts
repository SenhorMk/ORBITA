import { z } from 'zod';

import { supabaseServer } from '../lib/supabaseServer';
import type { VerifiedOrganizationScope } from '../lib/verifiedOrganizationScope';

/** Quantas movimentações o detalhe do produto mostra: as mais recentes. */
export const LIMITE_DE_MOVIMENTACOES = 20;

const MovimentacaoSchema = z.object({
  id: z.string(),
  tipo: z.enum(['ENTRADA', 'SAIDA']),
  origem: z.string().nullable(),
  quantidade: z.number().int(),
  created_at: z.string(),
});

export type MovimentacaoDeEstoque = z.infer<typeof MovimentacaoSchema>;

/**
 * O histórico de estoque de um produto, como o banco o registrou: a baixa da
 * venda (`BAIXA_ORGANIZACAO_VERIFICADA`) e o alinhamento com a situação do
 * Bling. Só leitura, e sempre dentro da organização verificada: o service role
 * ignora RLS, então o filtro por organização aqui é a barreira.
 */
export async function listarMovimentacoesDoProduto(
  scope: VerifiedOrganizationScope,
  produtoId: string,
): Promise<MovimentacaoDeEstoque[]> {
  const { data, error } = await supabaseServer
    .from('movimentacao_estoque')
    .select('id, tipo, origem, quantidade, created_at')
    .eq('organizacao_id', scope.organizationId)
    .eq('produto_id', produtoId)
    .order('created_at', { ascending: false })
    .limit(LIMITE_DE_MOVIMENTACOES);

  if (error) throw new Error(`Falha ao ler movimentações de estoque: ${error.message}`);
  return z.array(MovimentacaoSchema).parse(data ?? []);
}
