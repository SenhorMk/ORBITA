import { TituloFinanceiro, CategoriaFinanceira } from '../types';
import { supabaseServer } from '../lib/supabaseServer';

export class FinanceiroRepository {

  async getCategorias(userId: string): Promise<CategoriaFinanceira[]> {
    const { data, error } = await supabaseServer
      .from('categorias_financeiras')
      .select('*')
      .eq('user_id', userId)
      .order('descricao', { ascending: true });
      
    if (error) {
      console.error('Erro ao buscar categorias financeiras:', error);
      throw new Error(error.message);
    }
    
    return data || [];
  }

  async getCategoriaByBlingId(userId: string, blingId: number): Promise<CategoriaFinanceira | null> {
    const { data, error } = await supabaseServer
      .from('categorias_financeiras')
      .select('*')
      .eq('user_id', userId)
      .eq('bling_id', blingId)
      .maybeSingle();

    if (error) {
      console.error(`Erro ao buscar categoria bling_id=${blingId}:`, error);
      return null;
    }

    return data;
  }

  async getResumo(userId: string): Promise<{ receitas: number; despesas: number; saldo: number }> {
    const { data, error } = await supabaseServer
      .from('titulos_financeiros')
      .select('tipo, valor')
      .eq('user_id', userId)
      .eq('situacao', 'pago'); // Considerar apenas pagos para saldo líquido real

    if (error) {
      console.error('Erro ao buscar resumo financeiro:', error);
      throw new Error(error.message);
    }

    let receitas = 0;
    let despesas = 0;

    data?.forEach(titulo => {
      if (titulo.tipo === 'receber') receitas += Number(titulo.valor);
      if (titulo.tipo === 'pagar') despesas += Number(titulo.valor);
    });

    return {
      receitas,
      despesas,
      saldo: receitas - despesas
    };
  }

  async getTitulosFiltro(userId: string, filtros?: { tipo?: 'receber' | 'pagar', situacao?: string }): Promise<TituloFinanceiro[]> {
    let query = supabaseServer
      .from('titulos_financeiros')
      .select(`
        *,
        categoria:categoria_id (*)
      `)
      .eq('user_id', userId)
      .order('data_vencimento', { ascending: false });

    if (filtros?.tipo) {
      query = query.eq('tipo', filtros.tipo);
    }
    if (filtros?.situacao) {
      query = query.eq('situacao', filtros.situacao);
    }

    const { data, error } = await query;

    if (error) {
      console.error('Erro ao buscar títulos:', error);
      throw new Error(error.message);
    }

    return data || [];
  }

  async upsertTitulo(userId: string, titulo: TituloFinanceiro): Promise<TituloFinanceiro> {
    const payload = { ...titulo, user_id: userId };
    const { data, error } = await supabaseServer
      .from('titulos_financeiros')
      .upsert(payload, { onConflict: 'bling_id', ignoreDuplicates: false })
      .select()
      .single();

    if (error) {
      console.error('Erro no upsert do título financeiro:', error);
      throw new Error(error.message);
    }

    return data;
  }

}

export const financeiroRepository = new FinanceiroRepository();

