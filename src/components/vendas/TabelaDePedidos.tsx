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
 * Linha de 52px, cabeçalho fixo, sem zebra, hover — as medidas do Design System.
 */

const GRADE = '76px minmax(180px,1.4fr) 116px 150px 150px 116px 84px';

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
}: {
  pedidos: readonly PedidoEnriquecido[];
  acoes: AcoesDaLinha;
  /** O "agora" da tela, para a idade de cada pedido não se mexer sozinha. */
  agora: number;
}) {
  return (
    <div
      className="rounded-2xl overflow-hidden"
      style={{ background: 'var(--glass2)', border: '1px solid var(--line)' }}
    >
      <div className="overflow-x-auto">
        <div style={{ minWidth: 940 }}>
          <div
            className="orbita-tabela-cabecalho grid items-center gap-3 px-4"
            style={{ gridTemplateColumns: GRADE }}
          >
            <span>Pedido</span>
            <span>Cliente</span>
            <span>Origem</span>
            <span>Entrada</span>
            <span>Status</span>
            <span className="text-right">Total</span>
            <span className="text-right">Ações</span>
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
                className="orbita-tabela-linha grid items-center gap-3 px-4 py-2"
                style={{ gridTemplateColumns: GRADE }}
              >
                <button
                  type="button"
                  onClick={() => acoes.onAbrir(pedido)}
                  className="orbita-numero text-left text-[15px] cursor-pointer truncate"
                  title={`Abrir o pedido ${pedido.numero}`}
                >
                  #{pedido.numero}
                </button>

                <button
                  type="button"
                  onClick={() => acoes.onAbrir(pedido)}
                  className="flex flex-col items-start min-w-0 text-left cursor-pointer"
                >
                  <span className="text-[12.5px] font-medium truncate max-w-full" style={{ color: 'var(--txt)' }}>
                    {nome}
                  </span>
                  {documento && (
                    <span
                      className="text-[11px] truncate max-w-full"
                      style={{ color: 'var(--txt3)', fontFamily: 'var(--font-jetbrains-mono), monospace' }}
                    >
                      {documento}
                    </span>
                  )}
                </button>

                <span className="text-[12px]" style={{ color: 'var(--txt2)' }}>
                  {descreverOrigem(pedido.origem)}
                </span>

                <span className="flex flex-col">
                  <span className="text-[12px]" style={{ color: 'var(--txt2)' }}>
                    {formatarEntrada(pedido.data)}
                  </span>
                  {idade && (
                    <span className="text-[11px]" style={{ color: 'var(--txt3)' }}>
                      {idade}
                    </span>
                  )}
                </span>

                <StatusPill status={pedido.status} />

                <span className="orbita-numero text-right text-[15px]">{formatarReais(pedido.total)}</span>

                <span className="flex items-center justify-end gap-1">
                  {telefone && acoes.onConversarNoWhatsapp && (
                    <button
                      type="button"
                      onClick={() => acoes.onConversarNoWhatsapp?.(telefone, nome)}
                      title="Abrir a conversa no Chatwoot"
                      aria-label={`Conversar no WhatsApp com ${nome}`}
                      className="w-7 h-7 rounded-lg flex items-center justify-center cursor-pointer"
                      style={{ background: 'var(--chip)', border: '1px solid var(--line)', color: 'var(--txt2)' }}
                    >
                      <MessageCircle className="w-3.5 h-3.5" />
                    </button>
                  )}

                  <DropdownMenu
                    align="right"
                    trigger={
                      <button
                        type="button"
                        aria-label={`Ações do pedido ${pedido.numero}`}
                        className="w-7 h-7 rounded-lg flex items-center justify-center cursor-pointer"
                        style={{ background: 'var(--chip)', border: '1px solid var(--line)', color: 'var(--txt2)' }}
                      >
                        <MoreVertical className="w-3.5 h-3.5" />
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
    </div>
  );
}
