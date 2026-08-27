import { TituloFinanceiro, CategoriaFinanceira } from '../types';
import { supabaseServer } from '../lib/supabaseServer';
import type { VerifiedOrganizationScope } from '../lib/verifiedOrganizationScope';

export class FinanceiroRepository {
  async getCategorias(scope: VerifiedOrganizationScope): Promise<CategoriaFinanceira[]> {
    const { data, error } = await supabaseServer
      .from('categorias_financeiras')
      .select('*')
      .eq('organizacao_id', scope.organizationId)
      .order('descricao', { ascending: true });

    if (error) {
      console.error('Erro ao buscar categorias financeiras:', error.message);
      throw new Error(error.message);
    }

    return data || [];
  }

  async getCategoriaByBlingId(scope: VerifiedOrganizationScope, blingId: number): Promise<CategoriaFinanceira | null> {
    const { data, error } = await supabaseServer
      .from('categorias_financeiras')
      .select('*')
      .eq('organizacao_id', scope.organizationId)
      .eq('bling_id', blingId)
      .maybeSingle();

    if (error) {
      console.error(`Erro ao buscar categoria bling_id=${blingId}:`, error.message);
      return null;
    }

    return data;
  }

  async getResumo(scope: VerifiedOrganizationScope): Promise<{ receitas: number; despesas: number; saldo: number }> {
    const { data, error } = await supabaseServer
      .from('titulos_financeiros')
      .select('tipo, valor')
      .eq('organizacao_id', scope.organizationId)
      .eq('situacao', 'pago');

    if (error) {
      console.error('Erro ao buscar resumo financeiro:', error.message);
      throw new Error(error.message);
    }

    let receitas = 0;
    let despesas = 0;

    data?.forEach((titulo) => {
      if (titulo.tipo === 'receber') receitas += Number(titulo.valor);
      if (titulo.tipo === 'pagar') despesas += Number(titulo.valor);
    });

    return {
      receitas,
      despesas,
      saldo: receitas - despesas,
    };
  }

  async getTitulosFiltro(
    scope: VerifiedOrganizationScope,
    filtros?: { tipo?: 'receber' | 'pagar'; situacao?: string },
  ): Promise<TituloFinanceiro[]> {
    let query = supabaseServer
      .from('titulos_financeiros')
      .select(`
        *,
        categoria:categoria_id (*)
      `)
      .eq('organizacao_id', scope.organizationId)
      .order('data_vencimento', { ascending: false });

    if (filtros?.tipo) {
      query = query.eq('tipo', filtros.tipo);
    }
    if (filtros?.situacao) {
      query = query.eq('situacao', filtros.situacao);
    }

    const { data, error } = await query;

    if (error) {
      console.error('Erro ao buscar títulos:', error.message);
      throw new Error(error.message);
    }

    return data || [];
  }

  /**
   * Upsert de título financeiro. O payload de autoridade (organizacao_id,
   * user_id/actor) é sempre derivado do VerifiedOrganizationScope resolvido
   * no servidor — qualquer organizacao_id/user_id vindo em `titulo` (input
   * do caller) é ignorado e sobrescrito, nunca aceito como autoridade.
   * Idempotente por conexão/organização: onConflict em (organizacao_id,
   * bling_id) garante que uma reexecução do mesmo evento de sync atualiza
   * monotonicamente o mesmo registro em vez de duplicar.
   */
  async upsertTitulo(scope: VerifiedOrganizationScope, titulo: TituloFinanceiro): Promise<TituloFinanceiro> {
    // Allow-list every field accepted from the caller; organizacao_id/user_id
    // are never taken from `titulo` even if present, only from the
    // server-verified scope, so a client/provider-supplied authority field is
    // silently ignored rather than trusted.
    const payload = {
      id: titulo.id,
      bling_id: titulo.bling_id,
      tipo: titulo.tipo,
      situacao: titulo.situacao,
      valor: titulo.valor,
      data_vencimento: titulo.data_vencimento,
      data_pagamento: titulo.data_pagamento,
      descricao: titulo.descricao,
      categoria_id: titulo.categoria_id,
      conta_financeira_id: titulo.conta_financeira_id,
      fornecedor_id: titulo.fornecedor_id,
      organizacao_id: scope.organizationId,
      user_id: scope.actorId,
    };
    const { data, error } = await supabaseServer
      .from('titulos_financeiros')
      .upsert(payload, { onConflict: 'organizacao_id, bling_id', ignoreDuplicates: false })
      .select()
      .single();

    if (error) {
      console.error('Erro no upsert do título financeiro:', error.message);
      throw new Error(error.message);
    }

    return data;
  }
}

export const financeiroRepository = new FinanceiroRepository();
