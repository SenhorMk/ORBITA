'use client';

import { MessageCircle, MoreVertical } from 'lucide-react';

import type { PedidoEnriquecido } from '@/repositories/pedidoRepository';
import { StatusPill } from '@/components/ui/StatusPill';
import { pedidoContaComoVendaAtiva } from '@/lib/metricas/vendasAtivas';
import { DropdownMenu } from '@/components/DropdownMenu';
import { idadeDeIso } from '@/lib/tempoRelativo';
import { descreverOrigem } from './filtrosDeVendas';

/**
 * A tabela de pedidos.
 *
 * É uma tabela só, escrita para esta tela — e não um componente genérico de
 * tabelas. As colunas de Vendas são fixas e conhecidas; um `DataTable`
 * configurável seria mais código para servir a um único chamador, e a segunda
 * tela que precisar de tabela vai saber melhor do que esta o que generalizar.
 *
 * As medidas são as de `Orbita Vendas.dc.html` e mudam com a geometria: o
 * cabeçalho, a altura da linha, as colunas, o gap e o recuo saem de tokens, que
 * o protótipo reescreve em cada um dos três presets. A tabela ocupa o que sobra
 * da altura da janela — é ela que fica com o espaço, e não os cards.
 *
 * Duas colunas do protótipo não existem aqui e não foram inventadas: **CANAL**,
 * que pediria marketplace (o que existe é `origem`, de onde o pedido entrou), e
 * **ESPELHO BLING**, que pediria um segundo estado por pedido — só há um status,
 * e ele já é o espelho do ERP.
 */

/**
 * As colunas saem do token de geometria: o protótipo as reescreve nos três
 * presets, e não apenas as encolhe. Aqui elas chegam prontas.
 */
const GRADE = 'var(--tabela-cols)';

function formatarReais(valor: number | string | null | undefined): string {
  const numero = Number(valor ?? 0);
  return (Number.isFinite(numero) ? numero : 0).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  });
}

function formatarEntrada(iso: string): string {
  const quando = new Date(iso);
  if (!Number.isFinite(quando.getTime())) return '—';
  return quando.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function iniciaisDe(nome: string): string {
  return nome
    .split(' ')
    .filter(Boolean)
    .map((parte) => parte[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

export interface AcoesDaLinha {
  onAbrir: (pedido: PedidoEnriquecido) => void;
  onConversarNoWhatsapp?: (telefone: string, nome: string) => void;
  onEmitirNfe?: (pedido: PedidoEnriquecido) => void;
  onCancelar?: (pedido: PedidoEnriquecido) => void;
}

export function TabelaDePedidos({
  pedidos,
  acoes,
  agora,
  rodape,
}: {
  pedidos: readonly PedidoEnriquecido[];
  acoes: AcoesDaLinha;
  /** O "agora" da tela, para a idade de cada pedido não se mexer sozinha. */
  agora: number;
  rodape: string;
}) {
  return (
    <div
      className="flex flex-col flex-1 min-h-0 overflow-hidden"
      style={{ borderRadius: 22, background: 'var(--glass2)', border: '1px solid var(--line)' }}
    >
      <div className="flex-1 min-h-0 overflow-auto" style={{ scrollbarGutter: 'stable' }}>
        <div style={{ minWidth: 860 }}>
          <div
            className="orbita-tabela-cabecalho grid items-center"
            style={{ gridTemplateColumns: GRADE, gap: 'var(--tabela-gap)', padding: '0 var(--tabela-pad)' }}
          >
            <span>PEDIDO</span>
            <span>CLIENTE</span>
            <span>ORIGEM</span>
            <span>ENTRADA</span>
            <span>STATUS</span>
            <span className="text-right">TOTAL</span>
            <span />
          </div>

          {pedidos.map((pedido) => {
            const nome = pedido.cliente?.nome || 'Cliente Consumidor';
            const documento = pedido.cliente?.cpf_cnpj;
            const telefone = pedido.cliente?.telefone;
            const idade = idadeDeIso(pedido.data, agora);
            // O cancelado é reconhecido pelo radical, e não por igualdade: o
            // status chega de duas fontes e já apareceu como `Cancelado` e
            // `cancelado`. É a mesma frouxidão deliberada das métricas.
            const cancelado = !pedidoContaComoVendaAtiva(pedido);

            return (
              <div
                key={pedido.id || pedido.bling_id}
                className="orbita-tabela-linha grid items-center"
                style={{ gridTemplateColumns: GRADE, gap: 'var(--tabela-gap)', padding: '0 var(--tabela-pad)' }}
              >
                <button
                  type="button"
                  onClick={() => acoes.onAbrir(pedido)}
                  className="text-left cursor-pointer truncate"
                  style={{ font: '500 12.5px/1 var(--font-jetbrains-mono), monospace', color: 'var(--txt)' }}
                  title={`Abrir o pedido ${pedido.numero}`}
                >
                  #{pedido.numero}
                </button>

                <button
                  type="button"
                  onClick={() => acoes.onAbrir(pedido)}
                  className="flex items-center min-w-0 text-left cursor-pointer"
                  style={{ gap: 10 }}
                >
                  <span
                    className="flex items-center justify-center shrink-0 rounded-full"
                    style={{
                      width: 30,
                      height: 30,
                      background: 'var(--chip)',
                      border: '1px solid var(--line)',
                      font: '600 10.5px/1 var(--font-jetbrains-mono), monospace',
                      color: 'var(--txt2)',
                    }}
                    aria-hidden
                  >
                    {iniciaisDe(nome)}
                  </span>
                  <span className="flex flex-col min-w-0" style={{ gap: 3 }}>
                    <span
                      className="truncate"
                      style={{ font: '500 13px/1.2 var(--font-archivo), sans-serif', color: 'var(--txt)' }}
                    >
                      {nome}
                    </span>
                    {documento && (
                      <span
                        className="truncate"
                        style={{ font: '400 10.5px/1 var(--font-jetbrains-mono), monospace', color: 'var(--txt3)' }}
                      >
                        {documento}
                      </span>
                    )}
                  </span>
                </button>

                <span style={{ font: '400 12px/1.3 var(--font-archivo), sans-serif', color: 'var(--txt2)' }}>
                  {descreverOrigem(pedido.origem)}
                </span>

                <span className="flex flex-col" style={{ gap: 3 }}>
                  <span style={{ font: '500 12px/1 var(--font-jetbrains-mono), monospace', color: 'var(--txt)' }}>
                    {formatarEntrada(pedido.data)}
                  </span>
                  {idade && (
                    <span style={{ font: '400 10.5px/1 var(--font-archivo), sans-serif', color: 'var(--txt3)' }}>
                      {idade}
                    </span>
                  )}
                </span>

                <StatusPill status={pedido.status} />

                <span
                  className="text-right"
                  style={{
                    font: '500 14px/1 var(--font-space-grotesk), sans-serif',
                    letterSpacing: '-0.02em',
                    color: 'var(--txt)',
                  }}
                >
                  {formatarReais(pedido.total)}
                </span>

                <span className="flex items-center justify-end" style={{ gap: 4 }}>
                  {telefone && acoes.onConversarNoWhatsapp && (
                    <button
                      type="button"
                      onClick={() => acoes.onConversarNoWhatsapp?.(telefone, nome)}
                      title="Abrir a conversa no Chatwoot"
                      aria-label={`Conversar no WhatsApp com ${nome}`}
                      className="flex items-center justify-center cursor-pointer"
                      style={{ width: 28, height: 28, borderRadius: 9, color: 'var(--txt3)' }}
                    >
                      <MessageCircle className="w-[17px] h-[17px]" />
                    </button>
                  )}

                  <DropdownMenu
                    align="right"
                    trigger={
                      <button
                        type="button"
                        aria-label={`Ações do pedido ${pedido.numero}`}
                        className="flex items-center justify-center cursor-pointer"
                        style={{ width: 28, height: 28, borderRadius: 9, color: 'var(--txt3)' }}
                      >
                        <MoreVertical className="w-[17px] h-[17px]" />
                      </button>
                    }
                    sections={[
                      {
                        title: 'Pedido',
                        actions: [
                          {
                            id: 'abrir',
                            label: 'Abrir detalhes',
                            onClick: () => acoes.onAbrir(pedido),
                          },
                          {
                            id: 'nfe',
                            label: 'Emitir nota fiscal',
                            // Pedido cancelado não recebe NF-e. A ação some da
                            // mão de quem clica, e não só do resultado.
                            disabled: !acoes.onEmitirNfe || cancelado,
                            onClick: () => acoes.onEmitirNfe?.(pedido),
                          },
                          {
                            id: 'cancelar',
                            label: 'Cancelar pedido',
                            danger: true,
                            disabled: !acoes.onCancelar || cancelado,
                            onClick: () => acoes.onCancelar?.(pedido),
                          },
                        ],
                      },
                    ]}
                  />
                </span>
              </div>
            );
          })}
        </div>
      </div>

      <div
        className="flex items-center justify-between flex-none"
        style={{ padding: '11px var(--tabela-pad)', borderTop: '1px solid var(--line)' }}
      >
        <span style={{ font: '400 11.5px/1 var(--font-archivo), sans-serif', color: 'var(--txt3)' }}>
          {rodape}
        </span>
      </div>
    </div>
  );
}
