'use client';
import responsive from '@/components/ui/Responsive.module.css';

import { useMemo, useState } from 'react';

import { type Periodo } from '@/components/vendas/filtrosDeVendas';
import { cancelarDespesa, excluirLancamento } from '@/lib/correcaoOperacionalCliente';
import type { PedidoEnriquecido } from '@/repositories/pedidoRepository';

import { AcoesFinanceiras, AvisoSincronizacao } from './AcoesFinanceiras';
import { CabecalhoDoFinanceiro, CorpoDoFinanceiro } from './ComposicaoDoFinanceiro';
import {
  barrasDeEntradaESaida,
  recortarPorVencimento,
  serieDoFluxo,
  titulosElegiveis,
} from './derivacoesDoFinanceiro';
import { DetalhesDaMovimentacao } from './DetalheDaMovimentacao';
import { LancamentoDeDespesa } from './LancamentoDeDespesa';
import { OperacoesPendentes } from './OperacoesPendentes';
import { FiltroDeMovimentacoes, FiltroDePeriodo } from './Movimentacoes';
import { useLeituraFinanceira, type BuscaAutenticada, type TituloFinanceiro } from './useLeituraFinanceira';
import { HelpContext } from '@/components/help/HelpContext';

interface FinanceiroTabProps {
  fetchWithAuth: BuscaAutenticada;
  /** Organização ativa na tela; o lançamento de despesa separa suas operações por ela. */
  organizacaoId?: string | null;
  /**
   * A aba está visível?
   *
   * A tela fica MONTADA o tempo todo (o painel só a esconde com `hidden`), e a
   * busca acontecia uma vez, no mount. Uma venda manual registrada depois disso
   * não aparecia aqui até recarregar a página — o Financeiro mostrava um saldo
   * mais velho que o do painel ao lado. Reler quando a aba volta a aparecer
   * resolve sem inventar polling.
   */
  ativo?: boolean;
  /**
   * Os pedidos que o painel já leu.
   *
   * Servem de **snapshot local** para o `DrawerDoPedido`, que é o mesmo
   * componente que Vendas & Pedidos usa. Sem ele, um pedido apagado no Bling
   * abriria como "não encontrado" em vez de mostrar o registro que o ORBITA
   * tem. Nenhuma leitura nova é feita por causa disto.
   */
  pedidos?: readonly PedidoEnriquecido[] | null;
}

/**
 * Controle Financeiro.
 *
 * Os números continuam sendo os do servidor: o resumo vem pronto de
 * `GET /api/financeiro` e nada é recalculado aqui. Cancelado e estornado
 * continuam visíveis na lista e fora dos totais e dos gráficos.
 *
 * ## A ordem em que os recortes se aplicam
 *
 * ```
 * leitura do escopo {tipo} → recorte por período (vencimento) → TABELA
 *                                                → elegíveis → OS DOIS GRÁFICOS
 * ```
 *
 * O `tipo` muda a consulta e por isso **carimba** a leitura (ver
 * `useLeituraFinanceira`): dado de um filtro nunca aparece sob o rótulo de
 * outro. O período é recorte puro sobre a leitura corrente — não cruza a rede,
 * então não há como uma leitura estar velha em relação a ele.
 *
 * Os dois gráficos partem da **mesma** lista elegível, no mesmo período; a
 * tabela mostra também os terminais, porque o histórico é deles.
 */
export function FinanceiroTab({ fetchWithAuth, ativo = true, pedidos = null, organizacaoId = null }: FinanceiroTabProps) {
  const {
    titulos, categorias, resumo, nuncaCarregou, erroDeLeitura, carregando,
    syncing, setSyncing, avisoSync, filtroTipo, setFiltroTipo,
    fetchFinanceiro, syncFinanceiro,
  } = useLeituraFinanceira(fetchWithAuth, ativo);

  const [periodo, setPeriodo] = useState<Periodo>('all');
  /**
   * O "agora" da tela, fixado na montagem — o mesmo recurso de Vendas. Sem ele
   * o corte se moveria a cada renderização e a tabela poderia discordar dos
   * gráficos no mesmo desenho.
   */
  const [agora] = useState(() => Date.now());

  const noPeriodo = useMemo(
    () => recortarPorVencimento(titulos, periodo, agora),
    [titulos, periodo, agora],
  );
  const elegiveis = useMemo(
    () => titulosElegiveis(titulos, periodo, agora),
    [titulos, periodo, agora],
  );
  const serie = useMemo(() => serieDoFluxo(elegiveis), [elegiveis]);
  const barras = useMemo(() => barrasDeEntradaESaida(elegiveis), [elegiveis]);

  const [despesaAberta, setDespesaAberta] = useState(false);
  // Fechar o diálogo de despesa pode ter deixado uma operação pendente.
  const [versaoDasPendencias, setVersaoDasPendencias] = useState(0);
  const [detalhe, setDetalhe] = useState<TituloFinanceiro | null>(null);

  /**
   * O pedido que o ORBITA já tem em mãos, quando tem. A escolha entre o
   * detalhe de pedido e o detalhe avulso é feita pelo vínculo estrutural
   * `pedido_id` (migration 61), nunca pelo texto da descrição.
   */
  const pedidoLocal = detalhe?.pedido_id
    ? (pedidos ?? []).find((p) => p.id === detalhe.pedido_id) ?? null
    : null;

  const formatarDinheiro = (val: number) =>
    new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(val);

  return (
    <div className={`flex flex-col flex-1 min-h-0 ${responsive.page}`} style={{ gap: 'var(--conteudo-gap)' }}>

      <CabecalhoDoFinanceiro resumo={resumo} formatarDinheiro={formatarDinheiro} />

      <div className="flex items-center flex-none flex-wrap" style={{ gap: 10 }}>
        <HelpContext ajudaId="financeiro.filtros"><FiltroDePeriodo periodo={periodo} setPeriodo={setPeriodo} /></HelpContext>
        <FiltroDeMovimentacoes filtroTipo={filtroTipo} setFiltroTipo={setFiltroTipo} />
        <div className="flex-1" />
        <AcoesFinanceiras
          syncing={syncing}
          onSync={syncFinanceiro}
          onNovaDespesa={() => setDespesaAberta(true)}
        />
      </div>

      <AvisoSincronizacao mensagem={avisoSync} />

      <OperacoesPendentes
        fetchWithAuth={fetchWithAuth}
        ativo={ativo}
        versao={versaoDasPendencias}
        onConfirmada={() => { void fetchFinanceiro(); }}
      />

      <CorpoDoFinanceiro
        ativo={ativo}
        estado={{ nuncaCarregou, erroDeLeitura, carregando }}
        titulos={noPeriodo}
        serie={serie}
        barras={barras}
        formatarDinheiro={formatarDinheiro}
        onRecarregar={() => { void fetchFinanceiro(); }}
        onAbrirDetalhe={setDetalhe}
      />

      <DetalhesDaMovimentacao
        titulo={detalhe}
        pedidoLocal={pedidoLocal}
        onFechar={() => setDetalhe(null)}
        formatarDinheiro={formatarDinheiro}
        onCorrigir={(acao, tituloId) =>
          acao === 'excluir' ? excluirLancamento(fetchWithAuth, tituloId) : cancelarDespesa(fetchWithAuth, tituloId)}
        onCorrigido={() => {
          setDetalhe(null);
          void fetchFinanceiro();
        }}
      />

      <LancamentoDeDespesa
        fetchWithAuth={fetchWithAuth}
        aberto={despesaAberta}
        onFechar={() => { setDespesaAberta(false); setVersaoDasPendencias((v) => v + 1); }}
        onSalvo={() => { void fetchFinanceiro(); }}
        syncing={syncing}
        setSyncing={setSyncing}
        categorias={categorias}
        organizacaoId={organizacaoId}
      />
    </div>
  );
}
