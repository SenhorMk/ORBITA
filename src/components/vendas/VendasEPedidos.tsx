'use client';
import responsive from '@/components/ui/Responsive.module.css';
import { corDeTexto } from '@/components/ui/corDeTexto';

import { HelpContext, helpPageHeader } from '@/components/help/HelpContext';

import { useMemo, useReducer, useRef, useState } from 'react';
import { Search } from 'lucide-react';

import type { PedidoEnriquecido } from '@/repositories/pedidoRepository';
import { AvisoDeAtualizacaoFalhada, EstadoCarregando, EstadoDeErro, EstadoVazio } from '@/components/ui/estados';
import { PendenciasDeVendaManual } from '@/components/PendenciasDeVendaManual';
import { lerTentativasPendentes } from '@/components/tentativaPendente';
import { descreverTempoDesde } from '@/lib/tempoRelativo';
import { TabelaDePedidos } from './TabelaDePedidos';
import { DrawerDoPedido } from './DrawerDoPedido';
import { CancelamentoDePedido } from './CancelamentoDePedido';
import { ORDENS, PERIODOS, buscar, ordenar, recortarPorPeriodo, type Ordem, type Periodo } from './filtrosDeVendas';
import { calcularChips, ehChipDePedido, pedidosDoChip } from './resumoDeVendas';

/**
 * Vendas & Pedidos — a tela da jornada operacional.
 *
 * ## A ordem em que os filtros se aplicam, e por quê
 *
 * ```
 * pedidos carregados → recorte por período → CHIPS
 *                                          → filtro do chip → busca → ordenação → TABELA
 * ```
 *
 * Os chips são calculados sobre o período e **nada mais**. Nem a busca nem o
 * chip selecionado entram nessa base: se entrassem, os números mudariam por
 * causa do próprio clique — clicar em "A emitir NF-e" faria os outros chips
 * zerarem — e digitar na busca mudaria a resposta de "quantos pedidos aguardam
 * NF-e?", que é uma pergunta sobre a operação, não sobre o texto digitado.
 *
 * ## Esta tela é histórico
 *
 * Pedido cancelado continua listado, buscável e abrível. `apenasVendasAtivas`
 * não é aplicado à lista: ele só aparece dentro das regras dos chips, onde a
 * pergunta é mesmo "isto é venda?".
 */

interface VendasEPedidosProps {
  /** Os pedidos da última leitura boa, ou `null` se nenhuma leitura deu certo ainda. */
  pedidos: readonly PedidoEnriquecido[] | null;
  carregando: boolean;
  /** A falha da leitura mais recente, se houve. */
  erroDeLeitura: string | null;
  onRecarregar: () => void;
  organizacaoId: string | null;
  /** Última sincronização concluída **nesta sessão**, ou `null`. */
  ultimaSincronizacao: Date | null;
  busca: string;
  onBuscaChange: (texto: string) => void;
  onConversarNoWhatsapp?: (telefone: string, nome: string) => void;
  onEmitirNfe?: (pedido: PedidoEnriquecido) => void;
}

function formatarReais(valor: number): string {
  return valor.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

export function VendasEPedidos({
  pedidos,
  carregando,
  erroDeLeitura,
  onRecarregar,
  organizacaoId,
  ultimaSincronizacao,
  busca,
  onBuscaChange,
  onConversarNoWhatsapp,
  onEmitirNfe,
}: VendasEPedidosProps) {
  const [periodo, setPeriodo] = useState<Periodo>('all');
  const [ordem, setOrdem] = useState<Ordem>('recent');
  const [chipSelecionado, setChipSelecionado] = useState<string | null>(null);
  const [pedidoAberto, setPedidoAberto] = useState<PedidoEnriquecido | null>(null);
  const [pedidoParaCancelar, setPedidoParaCancelar] = useState<PedidoEnriquecido | null>(null);
  const [pendenciasEmDestaque, setPendenciasEmDestaque] = useState(false);
  /** Releitura das pendências depois de uma conferência mudar o armazenamento. */
  const [, relerPendencias] = useReducer((versao: number) => versao + 1, 0);
  /** O "agora" da tela, fixado na montagem: o recorte e as idades não se mexem sozinhos. */
  const [agora] = useState(() => Date.now());
  const blocoDePendencias = useRef<HTMLDivElement>(null);

  // A mesma leitura síncrona que `PendenciasDeVendaManual` faz, durante a
  // renderização e pelo mesmo motivo: é barata, dá sempre o mesmo resultado
  // para a mesma organização, e copiá-la para dentro do estado criaria uma
  // segunda verdade sobre quantas pendências existem. Quando uma conferência
  // muda o armazenamento, `relerPendencias` redesenha e a leitura sai nova.
  const pendencias = organizacaoId ? lerTentativasPendentes(organizacaoId) : [];

  const base = useMemo(
    () => (pedidos === null ? [] : recortarPorPeriodo(pedidos, periodo, agora)),
    [pedidos, periodo, agora],
  );

  const chips = useMemo(
    () => calcularChips(base, pendencias.length),
    [base, pendencias.length],
  );

  const listaVisivel = useMemo(() => {
    const doChip = ehChipDePedido(chipSelecionado) ? pedidosDoChip(base, chipSelecionado) : base;
    return ordenar(buscar(doChip, busca), ordem);
  }, [base, chipSelecionado, busca, ordem]);

  const nuncaCarregou = pedidos === null;
  const mostrarErroDeCarga = nuncaCarregou && erroDeLeitura !== null && !carregando;
  const mostrarCarregando = nuncaCarregou && !mostrarErroDeCarga;
  const mostrarAvisoDeAtualizacao = !nuncaCarregou && erroDeLeitura !== null;

  const alternarChip = (id: string, filtra: boolean) => {
    if (!filtra) {
      // "Conflito Bling" não filtra a lista: uma tentativa ambígua pode existir
      // sem pedido local nenhum, e filtrar por ela devolveria uma tabela vazia.
      // O clique leva a quem resolve.
      setPendenciasEmDestaque(true);
      blocoDePendencias.current?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
      return;
    }
    setChipSelecionado((atual) => (atual === id ? null : id));
  };

  return (
    <div className={`flex flex-col flex-1 min-h-0 ${responsive.page}`} style={{ gap: 'var(--conteudo-gap)' }}>

      {/* Título e resumo NA MESMA LINHA — a composição do protótipo. */}
      <div className={`flex items-start gap-8 flex-none ${helpPageHeader}`}>
        <div className="flex flex-col flex-none" style={{ width: 'var(--titulo-col)', gap: 13 }}>
          <HelpContext ajudaId="vendas.lista">
            <h1
              className="m-0"
              style={{
                fontFamily: 'var(--font-space-grotesk), sans-serif',
                fontWeight: 500,
                fontSize: 'var(--titulo-fs)',
                lineHeight: 1.04,
                letterSpacing: '-0.03em',
                color: 'var(--txt)',
              }}
            >
              Vendas &amp;<br />Pedidos
            </h1>
          </HelpContext>
          <div className="flex items-center gap-2.5 flex-wrap">
            <span
              className="inline-flex items-center"
              style={{
                gap: 7,
                height: 28,
                padding: '0 11px',
                borderRadius: 9,
                background: 'rgba(200,244,65,.16)',
                border: '1px solid rgba(200,244,65,.32)',
                font: '500 11px/1 var(--font-jetbrains-mono), monospace',
                color: 'var(--txt)',
              }}
            >
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--accent)' }} aria-hidden />
              {ultimaSincronizacao ? 'BLING SINCRONIZADO' : 'ESPELHO DO BLING'}
            </span>
            <span style={{ font: '400 11px/1 var(--font-jetbrains-mono), monospace', color: 'var(--txt3)' }}>
              {ultimaSincronizacao
                ? descreverTempoDesde(ultimaSincronizacao, agora)
                : 'sem sincronização registrada nesta sessão'}
            </span>
          </div>
        </div>

        {/*
          Chips de resumo — só existem quando existe uma leitura para resumir.
          Sem ela, um chip mostraria "0" e "R$ 0,00" ao lado de uma leitura que
          FALHOU, que é o mesmo erro de confundir zero com "não sei" — só que na
          posição mais visível da tela.
        */}
        {!nuncaCarregou && (
          <div
            className="flex-1 min-w-0 grid"
            style={{ gridTemplateColumns: 'repeat(' + chips.length + ', 1fr)', gap: 'var(--resumo-gap)' }}
          >
            {chips.map((chip) => {
              const selecionado = chip.filtraTabela && chipSelecionado === chip.id;
              return (
                <button
                  key={chip.id}
                  type="button"
                  onClick={() => alternarChip(chip.id, chip.filtraTabela)}
                  aria-pressed={chip.filtraTabela ? selecionado : undefined}
                  title={chip.explicacao}
                  className="flex flex-col justify-between text-left cursor-pointer"
                  style={{
                    gap: 12,
                    minHeight: 'var(--resumo-min)',
                    padding: '12px 13px',
                    borderRadius: 16,
                    background: 'var(--glass2)',
                    border: '1px solid ' + (selecionado ? 'var(--txt)' : 'var(--line)'),
                  }}
                >
                  <span
                    className="flex items-center"
                    style={{ gap: 7, font: '400 10.5px/1.35 var(--font-archivo), sans-serif', color: 'var(--txt2)' }}
                  >
                    <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: chip.cor }} aria-hidden />
                    {chip.rotulo}
                  </span>
                  <span className="flex items-baseline" style={{ gap: 7 }}>
                    <span className="orbita-numero" style={{ fontSize: 'var(--resumo-fs)', color: corDeTexto(chip.cor) }}>
                      {chip.quantidade}
                    </span>
                    {chip.soma !== null && (
                      <span style={{ font: '400 10.5px/1 var(--font-jetbrains-mono), monospace', color: 'var(--txt3)' }}>
                        {formatarReais(chip.soma)}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Pendências de venda manual — visíveis aqui, e não só dentro do modal */}
      <div
        ref={blocoDePendencias}
        className="flex-none empty:hidden"
        style={pendenciasEmDestaque ? { outline: '2px solid var(--danger)', outlineOffset: 4, borderRadius: 16 } : undefined}
      >
        <PendenciasDeVendaManual open organizacaoId={organizacaoId} onMudanca={relerPendencias} />
      </div>

      {/* Toolbar: períodos à esquerda, busca, espaço, ordenação. */}
      <div className={`flex items-center flex-none ${responsive.toolbar}`} style={{ gap: 10 }}>
        <div
          className={`flex ${responsive.pills}`}
          style={{ gap: 3, padding: 4, borderRadius: 14, background: 'var(--chip)', border: '1px solid var(--line)' }}
        >
          {PERIODOS.map((p) => {
            const ativo = periodo === p.id;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => setPeriodo(p.id)}
                aria-pressed={ativo}
                className="cursor-pointer"
                style={{
                  height: 30,
                  padding: '0 13px',
                  borderRadius: 11,
                  font: '600 12px/1 var(--font-archivo), sans-serif',
                  background: ativo ? 'var(--txt)' : 'transparent',
                  color: ativo ? 'var(--invTxt)' : 'var(--txt2)',
                }}
              >
                {p.rotulo}
              </button>
            );
          })}
        </div>

        <div
          className={`flex items-center flex-1 min-w-0 ${responsive.search}`}
          style={{
            gap: 10,
            height: 38,
            maxWidth: 340,
            padding: '0 14px',
            borderRadius: 13,
            background: 'var(--glass2)',
            border: '1px solid var(--line)',
          }}
        >
          <Search className="w-[18px] h-[18px] shrink-0" style={{ color: 'var(--txt3)' }} aria-hidden />
          <input
            type="search"
            value={busca}
            onChange={(evento) => onBuscaChange(evento.target.value)}
            placeholder="Pedido, cliente ou CPF/CNPJ"
            aria-label="Buscar pedido, cliente ou CPF/CNPJ"
            className="flex-1 min-w-0 bg-transparent outline-none"
            style={{ font: '400 13px/1 var(--font-archivo), sans-serif', color: 'var(--txt)' }}
          />
        </div>

        <div className="flex-1" />

        <select
          value={ordem}
          onChange={(evento) => setOrdem(evento.target.value as Ordem)}
          aria-label="Ordenação"
          className="cursor-pointer outline-none"
          style={{
            height: 38,
            padding: '0 13px',
            borderRadius: 13,
            background: 'var(--glass2)',
            border: '1px solid var(--line)',
            color: 'var(--txt2)',
            font: '600 12.5px/1 var(--font-archivo), sans-serif',
          }}
        >
          {ORDENS.map((o) => (
            <option key={o.id} value={o.id}>
              {o.rotulo}
            </option>
          ))}
        </select>
      </div>

      {mostrarAvisoDeAtualizacao && <AvisoDeAtualizacaoFalhada detalhe={erroDeLeitura ?? undefined} />}

      {/* A tabela ocupa o que sobra da janela. */}
      {mostrarCarregando && <EstadoCarregando mensagem="Carregando pedidos…" />}

      {mostrarErroDeCarga && (
        <EstadoDeErro
          titulo="Não foi possível carregar os pedidos"
          detalhe={erroDeLeitura ?? undefined}
          onTentarDeNovo={onRecarregar}
        />
      )}

      {!nuncaCarregou && listaVisivel.length === 0 && (
        <EstadoVazio
          titulo={base.length === 0 ? 'Nenhum pedido neste período' : 'Nenhum pedido corresponde ao filtro'}
          descricao={
            base.length === 0
              ? 'Amplie o período ou sincronize o Bling para trazer os pedidos mais recentes.'
              : 'Limpe a busca ou o chip selecionado para ver os demais pedidos.'
          }
        />
      )}

      {!nuncaCarregou && listaVisivel.length > 0 && (
        <TabelaDePedidos
          pedidos={listaVisivel}
          agora={agora}
          rodape={listaVisivel.length + ' de ' + base.length + ' pedidos no período · pedidos cancelados continuam no histórico'}
          acoes={{
            onAbrir: setPedidoAberto,
            onConversarNoWhatsapp,
            onEmitirNfe,
            onCancelar: setPedidoParaCancelar,
          }}
        />
      )}

      <DrawerDoPedido
        aberto={pedidoAberto !== null}
        onAbertoChange={(aberto) => {
          if (!aberto) setPedidoAberto(null);
        }}
        pedidoBlingId={pedidoAberto?.bling_id ?? null}
        pedidoLocal={pedidoAberto}
        onEmitirNfe={onEmitirNfe}
        onCancelar={(pedido) => {
          // O drawer sai de cena e o cancelamento acontece no MESMO diálogo da
          // tabela: a mesma decisão destrutiva tem uma única implementação.
          setPedidoAberto(null);
          setPedidoParaCancelar(pedido);
        }}
      />

      <CancelamentoDePedido
        pedido={pedidoParaCancelar}
        onFechar={() => setPedidoParaCancelar(null)}
        // A releitura que esta tela já sabe fazer, no lugar do
        // `window.location.reload()` que reiniciava o produto inteiro.
        onCancelado={onRecarregar}
      />
    </div>
  );
}
