import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { VerifiedOrganizationScope } from '../lib/verifiedOrganizationScope';

const linhas = z.array(z.object({
  nome: z.string(),
  codigo: z.string().nullable(),
  estoque: z.number().int().nullable(),
  estoque_reservado: z.number().int().nullable(),
}));

/** Leitura estreita do mesmo catálogo usado no painel de produtos. */
export async function lerSaldoDoProduto(banco: SupabaseClient, escopo: VerifiedOrganizationScope, referencia: string) {
  const base = () => banco.from('produtos').select('nome,codigo,estoque,estoque_reservado')
    .eq('organizacao_id', escopo.organizationId).eq('situacao', 'ativo').order('id').limit(6);
  const sku = await base().eq('codigo', referencia);
  if (sku.error) throw sku.error;
  if (sku.data?.length) return linhas.parse(sku.data);

  const nomeLiteral = referencia.replace(/[\\%_]/g, caractere => '\\' + caractere);
  const nome = await base().ilike('nome', '%' + nomeLiteral + '%');
  if (nome.error) throw nome.error;
  return linhas.parse(nome.data ?? []);
}
