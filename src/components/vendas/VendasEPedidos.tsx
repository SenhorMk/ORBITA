'use client';

import { useMemo, useReducer, useRef, useState } from 'react';
import { Plus, Search } from 'lucide-react';

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
  onAbrirVendaManual: () => void;
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
  onAbrirVendaManual,
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
    <div className="flex flex-col gap-5">
      {/* Cabeçalho da tela */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-2">
          <h1
            className="text-[34px] leading-none font-bold tracking-tight"
            style={{ fontFamily: 'var(--font-space-grotesk), sans-serif', color: 'var(--txt)' }}
          >
            Vendas &amp; Pedidos
          </h1>
          <div className="flex items-center gap-2">
            <span
              className="w-1.5 h-1.5 rounded-full"
              style={{ background: ultimaSincronizacao ? 'var(--info)' : 'var(--txt3)' }}
              aria-hidden
            />
            <span className="orbita-eyebrow" style={{ color: 'var(--info)' }}>
              Espelho do Bling
            </span>
            <span className="text-xs" style={{ color: 'var(--txt2)' }}>
              {ultimaSincronizacao
                ? `última sincronização ${descreverTempoDesde(ultimaSincronizacao, agora)}`
                : 'sem sincronização registrada nesta sessão'}
            </span>
          </div>
        </div>

        <button
          type="button"
          onClick={onAbrirVendaManual}
          className="orbita-chip cursor-pointer"
          style={{ background: 'var(--accent)', borderColor: 'var(--accent)', color: 'var(--accent-fg)' }}
        >
          <Plus className="w-4 h-4" />
          Novo pedido manual
        </button>
      </div>

      {/*
        Chips de resumo — só existem quando existe uma leitura para resumir.
        Sem ela, um chip mostraria "0" e "R$ 0,00" ao lado de uma leitura que
        FALHOU, que é o mesmo erro de confundir zero com "não sei" — só que na
        posição mais visível da tela.
      */}
      {!nuncaCarregou && (
      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))' }}>
        {chips.map((chip) => {
          const selecionado = chip.filtraTabela && chipSelecionado === chip.id;
          return (
            <button
              key={chip.id}
              type="button"
              onClick={() => alternarChip(chip.id, chip.filtraTabela)}
              aria-pressed={chip.filtraTabela ? selecionado : undefined}
              title={chip.explicacao}
              className="flex flex-col justify-between gap-3 rounded-2xl p-3 text-left cursor-pointer"
              style={{
                minHeight: 78,
                background: 'var(--glass2)',
                border: `1px solid ${selecionado ? 'var(--txt)' : 'var(--line)'}`,
              }}
            >
              <span className="flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: chip.cor }} aria-hidden />
                <span className="text-xs font-semibold" style={{ color: 'var(--txt2)' }}>
                  {chip.rotulo}
                </span>
              </span>
              <span className="flex items-baseline justify-between gap-2">
                <span className="orbita-numero text-[22px]" style={{ color: chip.cor }}>
                  {chip.quantidade}
                </span>
                {chip.soma !== null && (
                  <span className="orbita-numero text-[13px]" style={{ color: 'var(--txt2)' }}>
                    {formatarReais(chip.soma)}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
      )}

      {/* Pendências de venda manual — visíveis aqui, e não só dentro do modal */}
      <div
        ref={blocoDePendencias}
        className="rounded-2xl"
        style={pendenciasEmDestaque ? { outline: '2px solid var(--danger)', outlineOffset: 4 } : undefined}
      >
        <PendenciasDeVendaManual
          open
          organizacaoId={organizacaoId}
          onMudanca={relerPendencias}
        />
      </div>

      {/* Período, busca e ordenação */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1.5">
          {PERIODOS.map((p) => {
            const ativo = periodo === p.id;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => setPeriodo(p.id)}
                aria-pressed={ativo}
                className="h-[30px] px-3 rounded-xl text-xs font-semibold cursor-pointer"
                style={
                  ativo
                    ? { background: 'var(--txt)', color: 'var(--invTxt)' }
                    : { color: 'var(--txt2)', border: '1px solid var(--line)' }
                }
              >
                {p.rotulo}
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-2">
          <div className="relative">
            <Search
              className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 pointer-events-none"
              style={{ color: 'var(--txt3)' }}
              aria-hidden
            />
            <input
              type="search"
              value={busca}
              onChange={(evento) => onBuscaChange(evento.target.value)}
              placeholder="Pedido, cliente ou CPF/CNPJ"
              aria-label="Buscar pedido, cliente ou CPF/CNPJ"
              className="h-[38px] w-[268px] pl-9 pr-3 rounded-xl text-xs outline-none"
              style={{ background: 'var(--chip)', border: '1px solid var(--line)', color: 'var(--txt)' }}
            />
          </div>

          <select
            value={ordem}
            onChange={(evento) => setOrdem(evento.target.value as Ordem)}
            aria-label="Ordenação"
            className="h-[38px] px-3 rounded-xl text-xs font-semibold cursor-pointer outline-none"
            style={{ background: 'var(--chip)', border: '1px solid var(--line)', color: 'var(--txt2)' }}
          >
            {ORDENS.map((o) => (
              <option key={o.id} value={o.id}>
                {o.rotulo}
              </option>
            ))}
          </select>
        </div>
      </div>

      {mostrarAvisoDeAtualizacao && <AvisoDeAtualizacaoFalhada detalhe={erroDeLeitura ?? undefined} />}

      {/* Tabela e seus três estados */}
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
          titulo={
            base.length === 0
              ? 'Nenhum pedido neste período'
              : 'Nenhum pedido corresponde ao filtro'
          }
          descricao={
            base.length === 0
              ? 'Amplie o período ou sincronize o Bling para trazer os pedidos mais recentes.'
              : 'Limpe a busca ou o chip selecionado para ver os demais pedidos.'
          }
        />
      )}

      {!nuncaCarregou && listaVisivel.length > 0 && (
        <>
          <TabelaDePedidos
            pedidos={listaVisivel}
            agora={agora}
            acoes={{
              onAbrir: setPedidoAberto,
              onConversarNoWhatsapp,
              onEmitirNfe,
              onCancelar: setPedidoParaCancelar,
            }}
          />
          <p className="text-xs" style={{ color: 'var(--txt3)' }}>
            {listaVisivel.length} de {base.length} pedidos no período. Pedidos cancelados continuam
            no histórico.
          </p>
        </>
      )}

      <DrawerDoPedido
        aberto={pedidoAberto !== null}
        onAbertoChange={(aberto) => {
          if (!aberto) setPedidoAberto(null);
        }}
        pedidoBlingId={pedidoAberto?.bling_id ?? null}
        pedidoLocal={pedidoAberto}
        onEmitirNfe={onEmitirNfe}
      />

      <CancelamentoDePedido pedido={pedidoParaCancelar} onFechar={() => setPedidoParaCancelar(null)} />
    </div>
  );
}
