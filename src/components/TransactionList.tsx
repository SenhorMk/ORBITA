'use client';

import React, { useState } from "react";
import {
  ShoppingBag,
  FileText,
  MessageCircle,
  MoreVertical,
  CheckCircle2,
  Clock,
  AlertCircle,
  ExternalLink,
  Copy,
  Calendar,
  XCircle,
  RefreshCw
} from 'lucide-react';
import type { PedidoEnriquecido } from '@/repositories/pedidoRepository';
import { DropdownMenu } from './DropdownMenu';
import { OrderDetailModal } from './OrderDetailModal';

interface TransactionListProps {
  pedidos: PedidoEnriquecido[];
  onOpenChatwoot?: (phone?: string, name?: string) => void;
  onEmitirNfe?: (pedido: PedidoEnriquecido) => void;
  loading?: boolean;
}

export const TransactionList = React.memo(function TransactionList({
  pedidos,
  onOpenChatwoot,
  onEmitirNfe,
  loading = false
}: TransactionListProps) {
  const [selectedPedidoId, setSelectedPedidoId] = useState<string | null>(null);
  const [cancelModalOpen, setCancelModalOpen] = useState(false);
  const [pedidoToCancel, setPedidoToCancel] = useState<PedidoEnriquecido | null>(null);
  const [isCanceling, setIsCanceling] = useState(false);

  const handleCancelRequest = (pedido: PedidoEnriquecido) => {
    setPedidoToCancel(pedido);
    setCancelModalOpen(true);
  };

  const confirmCancel = async () => {
    if (!pedidoToCancel) return;
    setIsCanceling(true);

    try {
      // 1. Busca as situações
      const sitRes = await fetch('/api/bling/situacoes');
      const situacoes = (await sitRes.json()) as Array<{ id: number; nome: string }>;

      const situacaoCancelado = situacoes.find((s) => s.nome.toLowerCase() === 'cancelado' || s.nome.toLowerCase() === 'cancelada');

      if (!situacaoCancelado) {
        throw new Error('Situação "Cancelado" não encontrada no Bling.');
      }

      // 2. Faz o cancelamento
      const cancelRes = await fetch('/api/pedidos/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pedidoId: pedidoToCancel.id,
          novaSituacaoId: situacaoCancelado.id,
          novaSituacaoNome: situacaoCancelado.nome
        })
      });

      const cancelData = await cancelRes.json();
      if (!cancelRes.ok) throw new Error(cancelData.error || 'Falha ao cancelar');

      alert('Pedido cancelado e estoque alinhado com sucesso!');
      // Recarrega a página ou chama um callback onRefresh (aqui simplificado via window.location)
      window.location.reload();
    } catch (err: unknown) {
      alert(`Erro: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsCanceling(false);
      setCancelModalOpen(false);
      setPedidoToCancel(null);
    }
  };

  if (loading) {
    return (
      <div className="space-y-2.5">
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            className="h-16 rounded-2xl glass-card animate-pulse flex items-center justify-between p-4"
          >
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-white/10" />
              <div className="space-y-1.5">
                <div className="w-28 h-3.5 rounded bg-white/10" />
                <div className="w-20 h-2.5 rounded bg-white/5" />
              </div>
            </div>
            <div className="w-16 h-5 rounded bg-white/10" />
          </div>
        ))}
      </div>
    );
  }

  if (!pedidos || pedidos.length === 0) {
    return (
      <div className="glass-panel rounded-2xl p-8 text-center space-y-2 border border-white/10">
        <div className="w-10 h-10 rounded-full bg-white/5 border border-white/10 flex items-center justify-center mx-auto text-slate-400">
          <ShoppingBag className="w-5 h-5 text-slate-400" />
        </div>
        <h4 className="text-xs font-semibold text-slate-200">Sem pedidos registrados</h4>
        <p className="text-[11px] text-slate-400 max-w-sm mx-auto">
          Nenhum pedido real foi encontrado no banco de dados do Supabase. Conecte o Bling v3 e clique em &quot;Sincronizar Bling&quot;.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="space-y-2.5 select-none">
      {pedidos.map((pedido) => {
        const clienteNome = pedido.cliente?.nome || 'Cliente Consumidor';
        const clienteTelefone = pedido.cliente?.telefone;
        const nfeStatus = pedido.nfe?.status || 'Pendente';

        const isNfeEmitida = nfeStatus.toLowerCase().includes('emitid');
        const isNfeErro = nfeStatus.toLowerCase().includes('erro') || nfeStatus.toLowerCase().includes('rejeit');

        return (
          <div
            key={pedido.id || pedido.bling_id}
            className="group relative rounded-2xl glass-card p-3.5 flex flex-col md:flex-row md:items-center justify-between gap-3 border border-white/10 hover:border-white/20 transition-all duration-200"
          >
            <button
              type="button"
              onClick={() => setSelectedPedidoId(pedido.bling_id)}
              className="flex flex-col md:flex-row md:items-center gap-3 min-w-0 flex-1 text-left cursor-pointer"
            >
            {/* Left Side: Avatar + Details */}
            <div className="flex items-center gap-3 min-w-0">
              {/* iOS Neutral Avatar */}
              <div className="w-10 h-10 rounded-xl bg-zinc-800 flex items-center justify-center text-slate-200 font-bold text-xs flex-shrink-0 border border-white/10">
                {clienteNome.substring(0, 2).toUpperCase()}
              </div>

              {/* Info Column */}
              <div className="flex flex-col min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-xs text-white truncate">
                    {clienteNome}
                  </span>
                  <span className="text-[11px] font-mono px-2 py-0.5 rounded-md bg-white/5 text-slate-300 border border-white/10">
                    #{pedido.numero}
                  </span>
                </div>

                <div className="flex items-center gap-3 text-[11px] text-slate-400 mt-0.5 flex-wrap">
                  <span className="flex items-center gap-1">
                    <Calendar className="w-3 h-3 text-slate-500" />
                    {new Date(pedido.data).toLocaleDateString('pt-BR', {
                      day: '2-digit',
                      month: 'short',
                      hour: '2-digit',
                      minute: '2-digit'
                    })}
                  </span>

                  {pedido.cliente?.cpf_cnpj && (
                    <span className="font-mono text-slate-500">
                      Doc: {pedido.cliente.cpf_cnpj}
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* Right Side: Status Badges + Price */}
            <div className="flex items-center justify-between md:justify-end gap-4 border-t border-white/5 md:border-t-0 pt-2.5 md:pt-0">
              {/* NF-e Status Badge */}
              <div className="flex flex-col items-start md:items-end gap-0.5">
                <span
                  className={`text-[10px] px-2.5 py-0.5 rounded-full font-medium border flex items-center gap-1 uppercase tracking-wide ${
                    isNfeEmitida
                      ? 'bg-[#30D158]/15 text-[#30D158] border-[#30D158]/30'
                      : isNfeErro
                      ? 'bg-red-500/15 text-red-300 border-red-500/30'
                      : 'bg-[#FF9F0A]/15 text-[#FF9F0A] border-[#FF9F0A]/30'
                  }`}
                >
                  {isNfeEmitida ? (
                    <CheckCircle2 className="w-3 h-3 text-[#30D158]" />
                  ) : isNfeErro ? (
                    <AlertCircle className="w-3 h-3 text-red-400" />
                  ) : (
                    <Clock className="w-3 h-3 text-[#FF9F0A]" />
                  )}
                  {nfeStatus}
                </span>

                {pedido.status && (
                  <span className="text-[10px] text-slate-400 font-sans">
                    Bling: {pedido.status}
                  </span>
                )}
              </div>

              {/* Total Value */}
              <div className="flex flex-col items-end">
                <span className="text-sm font-bold text-white tracking-tight">
                  R${' '}
                  {Number(pedido.total).toLocaleString('pt-BR', {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2
                  })}
                </span>
              </div>
            </div>
            </button>

              {/* Quick Actions & Dropdown */}
              <div className="flex items-center gap-1.5 pl-2 border-l border-white/10">
                {clienteTelefone && onOpenChatwoot && (
                  <button
                    onClick={() => onOpenChatwoot(clienteTelefone, clienteNome)}
                    className="p-1.5 rounded-lg bg-[#30D158]/15 hover:bg-[#30D158]/30 border border-[#30D158]/30 text-[#30D158] transition-all"
                    title="Abrir WhatsApp no Chatwoot"
                  >
                    <MessageCircle className="w-3.5 h-3.5" />
                  </button>
                )}

                <DropdownMenu
                  align="right"
                  trigger={
                    <button className="p-1.5 rounded-lg bg-white/5 hover:bg-white/15 border border-white/10 text-slate-400 hover:text-white transition-all">
                      <MoreVertical className="w-3.5 h-3.5" />
                    </button>
                  }
                  sections={[
                    {
                      title: 'Ações Rápidas',
                      actions: [
                        {
                          id: 'details',
                          label: 'Ver Detalhes (Bling)',
                          icon: FileText,
                          onClick: (e?: React.MouseEvent) => {
                            e?.stopPropagation();
                            setSelectedPedidoId(pedido.bling_id);
                          }
                        },
                        {
                          id: 'whatsapp',
                          label: 'Conversar no WhatsApp',
                          icon: MessageCircle,
                          shortcut: '⌘+W',
                          disabled: !clienteTelefone,
                          onClick: () =>
                            clienteTelefone && onOpenChatwoot && onOpenChatwoot(clienteTelefone, clienteNome)
                        },
                        {
                          id: 'nfe',
                          label: isNfeEmitida ? 'Ver Nota Fiscal' : 'Emitir Nota Fiscal (Bling)',
                          icon: FileText,
                          shortcut: '⌘+N',
                          onClick: (e?: React.MouseEvent) => {
                            e?.stopPropagation();
                            if (onEmitirNfe) {
                              onEmitirNfe(pedido);
                            }
                          }
                        },
                        {
                          id: 'cancelar',
                          label: 'Cancelar Pedido',
                          icon: XCircle,
                          danger: true,
                          disabled: pedido.status === 'Cancelado',
                          onClick: (e?: React.MouseEvent) => {
                            e?.stopPropagation();
                            handleCancelRequest(pedido);
                          }
                        }
                      ]
                    },
                    {
                      title: 'Utilitários',
                      actions: [
                        {
                          id: 'copy_num',
                          label: `Copiar Nº Pedido (${pedido.numero})`,
                          icon: Copy,
                          onClick: () => navigator.clipboard.writeText(pedido.numero)
                        },
                        {
                          id: 'bling_link',
                          label: 'ID no Bling v3',
                          icon: ExternalLink,
                          onClick: () => alert(`ID do Pedido no Bling: ${pedido.bling_id}`)
                        }
                      ]
                    }
                  ]}
                />
              </div>
          </div>
        );
      })}
      </div>
      <OrderDetailModal
        open={!!selectedPedidoId}
        onOpenChange={(open) => !open && setSelectedPedidoId(null)}
        pedidoBlingId={selectedPedidoId}
      />

      {/* Modal de Cancelamento Simplificado (One Way Sync) */}
      {cancelModalOpen && pedidoToCancel && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="bg-[#1C1C1E] border border-white/10 rounded-2xl w-full max-w-md p-6 shadow-2xl animate-in fade-in zoom-in-95 duration-200">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-red-500/20 flex items-center justify-center flex-shrink-0">
                <AlertCircle className="w-5 h-5 text-red-500" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-white">Cancelar Pedido</h3>
                <p className="text-sm text-slate-400">Pedido #{pedidoToCancel.numero}</p>
              </div>
            </div>

            <p className="text-sm text-slate-300 mb-6 leading-relaxed">
              Tem certeza que deseja cancelar este pedido? O estoque será atualizado localmente de forma sincronizada, conforme as regras do seu ERP.
            </p>

            <div className="flex justify-end gap-3">
              <button
                onClick={() => {
                  if (!isCanceling) {
                    setCancelModalOpen(false);
                    setPedidoToCancel(null);
                  }
                }}
                disabled={isCanceling}
                className="px-4 py-2 rounded-xl text-sm font-medium text-slate-300 hover:text-white hover:bg-white/5 transition-colors disabled:opacity-50"
              >
                Voltar
              </button>
              <button
                onClick={confirmCancel}
                disabled={isCanceling}
                className="px-4 py-2 rounded-xl text-sm font-medium bg-red-500/20 text-red-400 hover:bg-red-500 hover:text-white border border-red-500/30 transition-all flex items-center gap-2 disabled:opacity-50"
              >
                {isCanceling ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    Processando...
                  </>
                ) : (
                  'Confirmar Cancelamento'
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
});
