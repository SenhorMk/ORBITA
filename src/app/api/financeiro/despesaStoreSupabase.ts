import { financeiroRepository } from '@/repositories/financeiroRepository';
import { supabaseServer } from '@/lib/supabaseServer';
import type { TituloFinanceiro } from '@/types';

import type { DespesaStorePort } from './despesaHandler';
import { tentativasDeContaPagarStore } from './tentativasDeContaPagarStore';

/** O `DespesaStorePort` da rota, sobre o Supabase: títulos, categorias e tentativas. */
export const despesaStore: DespesaStorePort = {
  ...tentativasDeContaPagarStore,

  async resolverCategoriaBling(scope, categoriaId) {
    const { data } = await supabaseServer
      .from('categorias_financeiras')
      .select('bling_id')
      .eq('organizacao_id', scope.organizationId)
      .eq('id', categoriaId)
      .maybeSingle();

    const blingId = Number(data?.bling_id);
    return Number.isSafeInteger(blingId) && blingId > 0 ? blingId : null;
  },

  async salvarTitulo(scope, titulo) {
    const essencial = {
      bling_id: titulo.blingId ?? undefined,
      tipo: 'pagar',
      situacao: titulo.situacao,
      valor: titulo.valor,
      data_vencimento: titulo.dataVencimento,
      descricao: titulo.descricao,
      categoria_id: titulo.categoriaId,
    } as TituloFinanceiro;

    const completo = {
      ...essencial,
      titulo: titulo.titulo,
      fornecedor_bling_id: titulo.fornecedorBlingId,
      fornecedor_nome: titulo.fornecedorNome,
    } as TituloFinanceiro;

    let salvo: TituloFinanceiro;
    let aviso: string | undefined;
    try {
      salvo = await financeiroRepository.upsertTitulo(scope, completo);
    } catch (erro: unknown) {
      // `PGRST204` é o PostgREST dizendo que a coluna não existe NESTE banco —
      // a migration 62 ainda não foi aplicada aqui. Isso não é motivo para
      // recusar a despesa: valor, data, categoria e situação são o que a
      // contabilidade precisa, e eles cabem no esquema antigo. O que não cabe
      // é dito em voz alta, em vez de sumir.
      if (!esquemaSemColunasNovas(erro)) throw erro;
      salvo = await financeiroRepository.upsertTitulo(scope, essencial);
      aviso = 'A despesa foi gravada, mas o título e o fornecedor não foram registrados: '
        + 'a migration 62 ainda não foi aplicada neste banco.';
    }

    return {
      id: String(salvo.id ?? ''),
      blingId: salvo.bling_id ? String(salvo.bling_id) : null,
      situacao: salvo.situacao ?? titulo.situacao,
      ...(aviso ? { aviso } : {}),
    };
  },
};

/**
 * O banco ainda não tem as colunas que a migration 62 cria?
 *
 * O sinal é o `code` do PostgREST, e não o texto da mensagem: `PGRST204` é
 * "coluna não encontrada no cache de esquema". A causa vem anexada ao erro que
 * o repositório lança justamente para esta pergunta poder ser feita.
 */
function esquemaSemColunasNovas(erro: unknown): boolean {
  const causa = erro instanceof Error ? erro.cause : erro;
  return typeof causa === 'object' && causa !== null && (causa as { code?: unknown }).code === 'PGRST204';
}
