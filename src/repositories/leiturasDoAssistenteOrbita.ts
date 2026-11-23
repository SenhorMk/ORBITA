import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

import type { VerifiedOrganizationScope } from '../lib/verifiedOrganizationScope';

const moeda = z.number().finite().nullable();
const venda = z.object({ id: z.string().uuid(), numero: z.string().nullable(), bling_id: z.string(),
  status: z.string().nullable(), data: z.string().nullable(), total: moeda, cliente_id: z.string().uuid().nullable() });
const item = z.object({ id: z.string().uuid(), produto_id: z.string().uuid().nullable(), produto_nome: z.string().nullable(),
  quantidade: z.number().finite(), valor_unitario: moeda });
const produto = z.object({ nome: z.string(), codigo: z.string().nullable(), estoque: z.number().int(), estoque_reservado: z.number().int() });

type Venda = z.infer<typeof venda>;
type Item = z.infer<typeof item>;

const COLUNAS_VENDA = 'id,numero,bling_id,status,data,total,cliente_id';
const LIMITE_VENDAS = 200;
const LIMITE_ITENS = 2_000;

export class IntervaloComMuitosRegistros extends Error {}

export function leiturasDoAssistente(banco: SupabaseClient, escopo: VerifiedOrganizationScope, sinal: AbortSignal) {
  const vendas = () => banco.from('pedidos').select(COLUNAS_VENDA).eq('organizacao_id', escopo.organizationId);
  const itens = () => banco.from('itens_pedido').select('id,produto_id,produto_nome,quantidade,valor_unitario')
    .eq('organizacao_id', escopo.organizationId);

  return {
    async vendasNoPeriodo(inicio: string, fimExclusivo: string): Promise<Venda[]> {
      const { data, error } = await vendas().gte('data', inicio).lt('data', fimExclusivo)
        .order('id').limit(LIMITE_VENDAS + 1).abortSignal(sinal);
      if (error) throw error;
      if ((data?.length ?? 0) > LIMITE_VENDAS) throw new IntervaloComMuitosRegistros();
      return venda.array().parse(data ?? []);
    },

    async itensDasVendas(ids: string[]): Promise<Item[]> {
      if (ids.length === 0) return [];
      const resultado: Item[] = [];
      for (let offset = 0; offset <= LIMITE_ITENS; offset += 500) {
        const { data, error } = await itens().in('pedido_id', ids).order('id')
          .range(offset, offset + 499).abortSignal(sinal);
        if (error) throw error;
        const bloco = item.array().parse(data ?? []);
        resultado.push(...bloco);
        if (resultado.length > LIMITE_ITENS) throw new IntervaloComMuitosRegistros();
        if (bloco.length < 500) break;
      }
      const idsSemNome = [...new Set(resultado.flatMap(i => i.produto_id && !i.produto_nome ? [i.produto_id] : []))];
      const nomes = new Map<string, string>();
      for (let offset = 0; offset < idsSemNome.length; offset += 150) {
        const { data, error } = await banco.from('produtos').select('id,nome')
          .eq('organizacao_id', escopo.organizationId).in('id', idsSemNome.slice(offset, offset + 150)).abortSignal(sinal);
        if (error) throw error;
        for (const p of data ?? []) nomes.set(p.id, p.nome);
      }
      return resultado.map(i => ({
        ...i, produto_nome: i.produto_nome || (i.produto_id ? nomes.get(i.produto_id) : null) || null,
      }));
    },

    async pedido(referencia: string, por: 'numero' | 'bling'): Promise<Venda[]> {
      const campo = por === 'numero' ? 'numero' : 'bling_id';
      const { data, error } = await vendas().eq(campo, referencia).order('id').limit(2).abortSignal(sinal);
      if (error) throw error;
      return venda.array().parse(data ?? []);
    },

    async estoqueBaixo(limite: number) {
      const lista = await banco.from('produtos').select('nome,codigo,estoque,estoque_reservado')
        .eq('organizacao_id', escopo.organizationId).eq('situacao', 'ativo')
        .not('estoque', 'is', null).not('estoque_reservado', 'is', null)
        .order('id').limit(501).abortSignal(sinal);
      if (lista.error) throw lista.error;
      if ((lista.data?.length ?? 0) > 500) throw new IntervaloComMuitosRegistros();
      return produto.array().parse(lista.data ?? []).map(p => ({
        ...p, disponivel: Math.max(0, p.estoque - p.estoque_reservado),
      })).filter(p => p.disponivel <= limite).sort((a, b) => a.disponivel - b.disponivel || a.nome.localeCompare(b.nome));
    },
  };
}

export type LeiturasDoAssistente = ReturnType<typeof leiturasDoAssistente>;
