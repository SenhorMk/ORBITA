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

  /**
   * Entradas, saídas e saldo ATIVOS.
   *
   * `cancelado` e `estornado` são estados terminais: o título continua no
   * histórico e nas Últimas Movimentações, mas sai dos totais. Um pedido
   * revertido no ERP não pode seguir somando receita — era o que acontecia
   * enquanto o título ficava `pago` para sempre, sem vínculo com o pedido.
   *
   * O filtro é por `situacao = 'pago'`, então os dois estados novos já ficam
   * de fora por construção; a asserção existe para que uma mudança futura
   * nesse filtro não os traga de volta em silêncio.
   */
  async getResumo(scope: VerifiedOrganizationScope): Promise<{ receitas: number; despesas: number; saldo: number }> {
    const { data, error } = await supabaseServer
      .from('titulos_financeiros')
      .select('tipo, valor, situacao')
      .eq('organizacao_id', scope.organizationId)
      .eq('situacao', 'pago');

    if (error) {
      console.error('Erro ao buscar resumo financeiro:', error.message);
      throw new Error(error.message);
    }

    let receitas = 0;
    let despesas = 0;

    data?.forEach((titulo) => {
      // Defesa em profundidade: se o filtro acima algum dia deixar passar um
      // terminal, ele ainda não entra no total.
      if (titulo.situacao === 'cancelado' || titulo.situacao === 'estornado') return;
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
      // `select('*')` de propósito, e **sem join com `pedidos`**.
      //
      // O vínculo `pedido_id` existe no repositório desde a migration 61 e vem
      // por aqui quando a coluna está aplicada; um join explícito, porém, é um
      // contrato duro: numa base onde a 61 ainda não rodou, o PostgREST recusa
      // a consulta inteira ("Could not find a relationship") e a tela do
      // dinheiro fica em branco por causa de um enfeite. Quem liga o título ao
      // pedido é a tela, com os pedidos que o painel já leu.
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
   * O pedido local de cada conta a receber que declara ter nascido de uma
   * venda — e só quando a resposta é única.
   *
   * O identificador é `origem.id` da conta (`ContasReceberDadosOrigemDTO`, do
   * OpenAPI oficial), já filtrado por `tipoOrigem === 'venda'` de quem chama.
   * Aqui ele vira o `pedidos.id` desta organização. Nada é inferido por valor,
   * data, cliente ou texto.
   *
   * Três casos ficam de fora, deliberadamente sem palpite:
   *
   * 1. o pedido não é desta organização (ou ainda não chegou aqui) — a busca é
   *    escopada por `organizacao_id`, e o que não aparece não vira vínculo;
   * 2. o pedido já tem um título `receber` de OUTRA conta — o índice único
   *    `uq_titulo_por_pedido_e_tipo` admite um só, e roubar o vínculo de quem
   *    já está lá reescreveria história;
   * 3. duas ou mais contas do mesmo lote apontam para o mesmo pedido (venda
   *    parcelada) — escolher uma parcela seria arbitrário.
   */
  async vincularPedidos(
    scope: VerifiedOrganizationScope,
    candidatos: readonly { readonly contaBlingId: number; readonly pedidoBlingId: string }[],
  ): Promise<ReadonlyMap<number, string>> {
    const vazio: ReadonlyMap<number, string> = new Map();
    if (candidatos.length === 0) return vazio;

    // Caso 3: pedido disputado por mais de uma conta neste lote.
    const contasPorPedido = new Map<string, number>();
    for (const c of candidatos) {
      contasPorPedido.set(c.pedidoBlingId, (contasPorPedido.get(c.pedidoBlingId) ?? 0) + 1);
    }
    const disputados = new Set([...contasPorPedido].filter(([, n]) => n > 1).map(([id]) => id));

    const procurados = [...new Set(candidatos.map((c) => c.pedidoBlingId))].filter((id) => !disputados.has(id));
    if (procurados.length === 0) return vazio;

    const { data: pedidos, error: erroPedidos } = await supabaseServer
      .from('pedidos')
      .select('id, bling_id')
      .eq('organizacao_id', scope.organizationId)
      .in('bling_id', procurados);

    if (erroPedidos) {
      console.error('Erro ao resolver pedidos de contas a receber:', erroPedidos.message);
      throw new Error(erroPedidos.message, { cause: erroPedidos });
    }

    const pedidoPorBlingId = new Map<string, string>();
    for (const pedido of pedidos ?? []) {
      if (pedido.id && pedido.bling_id !== null) pedidoPorBlingId.set(String(pedido.bling_id), String(pedido.id));
    }
    if (pedidoPorBlingId.size === 0) return vazio;

    const { data: existentes, error: erroTitulos } = await supabaseServer
      .from('titulos_financeiros')
      .select('pedido_id, bling_id')
      .eq('organizacao_id', scope.organizationId)
      .eq('tipo', 'receber')
      .in('pedido_id', [...pedidoPorBlingId.values()]);

    if (erroTitulos) {
      console.error('Erro ao conferir títulos já vinculados:', erroTitulos.message);
      throw new Error(erroTitulos.message, { cause: erroTitulos });
    }

    const ocupantePorPedido = new Map<string, number>();
    for (const titulo of existentes ?? []) {
      if (titulo.pedido_id) ocupantePorPedido.set(String(titulo.pedido_id), Number(titulo.bling_id));
    }

    const vinculos = new Map<number, string>();
    for (const candidato of candidatos) {
      if (disputados.has(candidato.pedidoBlingId)) continue;
      const pedidoId = pedidoPorBlingId.get(candidato.pedidoBlingId);
      if (!pedidoId) continue;
      const ocupante = ocupantePorPedido.get(pedidoId);
      if (ocupante !== undefined && ocupante !== candidato.contaBlingId) continue;
      vinculos.set(candidato.contaBlingId, pedidoId);
    }
    return vinculos;
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
      titulo: titulo.titulo,
      descricao: titulo.descricao,
      pedido_id: titulo.pedido_id,
      categoria_id: titulo.categoria_id,
      conta_financeira_id: titulo.conta_financeira_id,
      fornecedor_id: titulo.fornecedor_id,
      fornecedor_bling_id: titulo.fornecedor_bling_id,
      fornecedor_nome: titulo.fornecedor_nome,
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
      // A causa vai junto: o `code` do PostgREST é o que distingue "esta
      // coluna ainda não existe neste banco" de uma falha de verdade, e
      // `new Error(message)` sozinho apagava justamente isso.
      throw new Error(error.message, { cause: error });
    }

    return data;
  }
}

export const financeiroRepository = new FinanceiroRepository();
