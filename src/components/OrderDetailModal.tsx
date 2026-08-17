'use client';

import React, { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Loader2, Package, User, MapPin, Truck, Calendar, FileText, CheckCircle2, AlertCircle, Clock, Trash2, Pencil, Receipt } from 'lucide-react';
import { BlingPedido } from '@/types';
import { supabase } from '@/lib/supabaseClient';
import { ErrorLogModal } from '@/components/ErrorLogModal';
import { EditOrderModal } from '@/components/EditOrderModal';

interface OrderDetailModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pedidoId?: string | null;
  pedidoBlingId: string | null;
}

export function OrderDetailModal({ open, onOpenChange, pedidoId, pedidoBlingId }: OrderDetailModalProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pedido, setPedido] = useState<BlingPedido | null>(null);
  const [isEditOpen, setIsEditOpen] = useState(false);

  useEffect(() => {
    if (open && pedidoBlingId) {
      fetchPedido(pedidoBlingId);
    } else {
      setPedido(null);
      setError(null);
    }
  }, [open, pedidoBlingId]);

  const fetchPedido = async (id: string) => {
    try {
      setLoading(true);
      setError(null);

      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;

      // Ensure the ID is URI encoded to handle '#MANUAL-...' IDs that break the API route URL
      const res = await fetch(`/api/bling/pedidos/${encodeURIComponent(id)}`, {
        headers: {
          ...(token ? { 'Authorization': `Bearer ${token}` } : {})
        }
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Erro ao carregar detalhes do pedido');
      }
      setPedido(data.data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const [isDeleting, setIsDeleting] = useState(false);
  const [errorLog, setErrorLog] = useState<{ isOpen: boolean; message: string; details?: string; logs: string[] }>({
    isOpen: false,
    message: '',
    logs: []
  });

  const handleDelete = async () => {
    if (!pedidoBlingId) return;
    
    // Confirmação dupla
    if (!confirm('ATENÇÃO: Tem certeza que deseja apagar este pedido? Esta ação excluirá os dados no App e também no Bling ERP.')) return;

    try {
      setIsDeleting(true);
      
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      
      const res = await fetch(`/api/bling/pedidos/${encodeURIComponent(pedidoBlingId)}`, {
        method: 'DELETE',
        headers: {
          ...(token ? { 'Authorization': `Bearer ${token}` } : {})
        }
      });
      
      const data = await res.json();
      
      if (!res.ok) {
        throw new Error(data.error || 'Falha ao excluir o pedido');
      }

      alert('Pedido apagado com sucesso!');
      onOpenChange(false);
      // Aqui idealmente recarregamos a lista chamando uma função do pai, mas só fechando o modal já ajuda. (Pode disparar um event)
      window.dispatchEvent(new CustomEvent('pedido-apagado')); // Evento customizado para a lista recarregar, caso queira implementar
      
    } catch (err: any) {
      setErrorLog({
        isOpen: true,
        message: 'Erro ao Apagar Pedido',
        details: err.message,
        logs: [`DELETE /api/bling/pedidos/${pedidoBlingId}`, `Erro retornado: ${err.message}`]
      });
    } finally {
      setIsDeleting(false);
    }
  };

  const getStatusColor = (status?: any) => {
    if (!status) return 'bg-slate-500/15 text-slate-400 border-slate-500/30';
    const s = String(status).toLowerCase();
    if (s.includes('atendido') || s.includes('entregue') || s.includes('enviado')) return 'bg-[#30D158]/15 text-[#30D158] border-[#30D158]/30';
    if (s.includes('cancelado')) return 'bg-red-500/15 text-red-400 border-red-500/30';
    return 'bg-[#0A84FF]/15 text-[#0A84FF] border-[#0A84FF]/30';
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[800px] max-h-[90vh] overflow-y-auto bg-[#0a0f1c] border-white/10 text-white">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-xl font-black">
            <Package className="w-6 h-6 text-[#0A84FF]" />
            Detalhes do Pedido
          </DialogTitle>
          <DialogDescription className="text-slate-400">
            Informações completas carregadas diretamente do Bling.
          </DialogDescription>
        </DialogHeader>

        {loading && (
          <div className="flex flex-col items-center justify-center py-20 text-slate-400">
            <Loader2 className="w-8 h-8 animate-spin mb-4 text-[#0A84FF]" />
            <p className="text-sm">Buscando dados no Bling ERP...</p>
          </div>
        )}

        {error && !loading && (
          <div className="bg-red-500/10 border border-red-500/20 p-4 rounded-2xl flex flex-col items-center text-center py-10 mt-4">
            <AlertCircle className="w-8 h-8 text-red-400 mb-2" />
            <p className="text-red-400 font-medium">{error}</p>
            <Button variant="outline" className="mt-4 border-red-500/30 text-red-400 hover:bg-red-500/20" onClick={() => fetchPedido(pedidoBlingId!)}>
              Tentar Novamente
            </Button>
          </div>
        )}

        {pedido && !loading && (
          <div className="mt-6 space-y-6">
            
            {/* Header Info */}
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-white/5 p-4 rounded-2xl border border-white/10">
              <div>
                <h3 className="text-lg font-bold">Pedido #{pedido.numero}</h3>
                <div className="flex items-center gap-2 text-sm text-slate-400 mt-1">
                  <Calendar className="w-4 h-4" />
                  {new Date(pedido.data).toLocaleString('pt-BR')}
                </div>
              </div>
              <div className="flex flex-col md:items-end gap-1">
                <span className={`px-3 py-1 rounded-full text-xs font-bold border uppercase tracking-wide flex items-center gap-1.5 ${getStatusColor(pedido.situacao?.valor)}`}>
                  {pedido.situacao?.valor || 'Desconhecido'}
                </span>
                <span className="text-xl font-black text-white mt-1">
                  R$ {Number(pedido.total).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                </span>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Cliente */}
              <div className="bg-white/5 p-4 rounded-2xl border border-white/10">
                <h4 className="text-sm font-bold text-slate-300 flex items-center gap-2 mb-3 uppercase tracking-wider">
                  <User className="w-4 h-4 text-emerald-400" />
                  Dados do Cliente
                </h4>
                <div className="space-y-2 text-sm">
                  <p><span className="text-slate-500 font-medium">Nome:</span> <span className="text-slate-200 font-medium">{pedido.contato.nome}</span></p>
                  {pedido.contato.numeroDocumento && <p><span className="text-slate-500 font-medium">Doc:</span> <span className="text-slate-300">{pedido.contato.numeroDocumento}</span></p>}
                  {pedido.contato.telefone && <p><span className="text-slate-500 font-medium">Telefone:</span> <span className="text-slate-300">{pedido.contato.telefone}</span></p>}
                  {pedido.contato.email && <p><span className="text-slate-500 font-medium">E-mail:</span> <span className="text-slate-300">{pedido.contato.email}</span></p>}
                </div>
              </div>

              {/* Endereço / Transporte */}
              <div className="bg-white/5 p-4 rounded-2xl border border-white/10">
                <h4 className="text-sm font-bold text-slate-300 flex items-center gap-2 mb-3 uppercase tracking-wider">
                  <Truck className="w-4 h-4 text-purple-400" />
                  Transporte e Entrega
                </h4>
                {pedido.transporte?.etiqueta ? (
                  <div className="space-y-2 text-sm">
                    <p className="text-slate-300">
                      {pedido.transporte.etiqueta.endereco}, {pedido.transporte.etiqueta.numero}
                      {pedido.transporte.etiqueta.complemento ? ` - ${pedido.transporte.etiqueta.complemento}` : ''}
                    </p>
                    <p className="text-slate-300">{pedido.transporte.etiqueta.bairro}</p>
                    <p className="text-slate-300">{pedido.transporte.etiqueta.municipio} - {pedido.transporte.etiqueta.uf}</p>
                    <p className="text-slate-300">CEP: {pedido.transporte.etiqueta.cep}</p>
                    {pedido.transporte.frete !== undefined && (
                      <p className="mt-2 text-slate-400 border-t border-white/10 pt-2">
                        Valor do Frete: <span className="text-white font-medium">R$ {Number(pedido.transporte.frete).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</span>
                      </p>
                    )}
                  </div>
                ) : (
                  <p className="text-sm text-slate-400 italic">Sem informações de endereço disponíveis.</p>
                )}
              </div>
            </div>

            {/* Itens do Pedido */}
            <div className="bg-white/5 p-4 rounded-2xl border border-white/10">
              <h4 className="text-sm font-bold text-slate-300 flex items-center gap-2 mb-3 uppercase tracking-wider">
                <FileText className="w-4 h-4 text-orange-400" />
                Itens do Pedido ({pedido.itens?.length || 0})
              </h4>
              <div className="overflow-x-auto">
                <table className="w-full text-sm text-left">
                  <thead className="text-xs text-slate-400 bg-white/5 uppercase">
                    <tr>
                      <th className="px-4 py-2 rounded-l-lg">Código</th>
                      <th className="px-4 py-2">Descrição</th>
                      <th className="px-4 py-2 text-center">Qtd</th>
                      <th className="px-4 py-2 text-right">V. Unit</th>
                      <th className="px-4 py-2 text-right rounded-r-lg">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pedido.itens?.map((item, idx) => (
                      <tr key={idx} className="border-b border-white/5 last:border-0 hover:bg-white/5">
                        <td className="px-4 py-3 font-mono text-xs text-slate-400">{item.codigo || '-'}</td>
                        <td className="px-4 py-3 text-white font-medium">{item.descricao}</td>
                        <td className="px-4 py-3 text-center text-slate-300">{item.quantidade}</td>
                        <td className="px-4 py-3 text-right text-slate-300">R$ {Number(item.valorunitario || item.valor || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</td>
                        <td className="px-4 py-3 text-right font-bold text-slate-200">R$ {(Number(item.quantidade) * Number(item.valorunitario || item.valor || 0)).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Observações */}
            {(pedido.observacoes || pedido.observacoesInternas) && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {pedido.observacoes && (
                  <div className="bg-yellow-500/10 p-4 rounded-2xl border border-yellow-500/20">
                    <h4 className="text-xs font-bold text-yellow-400 uppercase tracking-wider mb-2">Observações (Cliente)</h4>
                    <p className="text-sm text-yellow-100 whitespace-pre-wrap">{pedido.observacoes}</p>
                  </div>
                )}
                {pedido.observacoesInternas && (
                  <div className="bg-purple-500/10 p-4 rounded-2xl border border-purple-500/20">
                    <h4 className="text-xs font-bold text-purple-400 uppercase tracking-wider mb-2">Observações Internas</h4>
                    <p className="text-sm text-purple-100 whitespace-pre-wrap">{pedido.observacoesInternas}</p>
                  </div>
                )}
              </div>
            )}

          </div>
        )}

        {/* Actions Footer - Sempre Visível para permitir Exclusão de Pedidos Órfãos */}
        <div className="flex flex-col sm:flex-row items-center justify-end gap-3 mt-6 pt-6 border-t border-white/10">
          <Button 
            variant="outline" 
            onClick={handleDelete}
            disabled={isDeleting}
            className="w-full sm:w-auto border-white/10 hover:bg-red-500/10 hover:text-red-400 hover:border-red-500/30 text-slate-300 transition-colors">
            {isDeleting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Trash2 className="w-4 h-4 mr-2" />}
            {isDeleting ? 'Apagando...' : 'Apagar'}
          </Button>
          <Button 
            variant="outline" 
            onClick={() => {
              if (!pedido) return;
              if (String(pedido.situacao?.valor || '').toLowerCase().includes('emitid')) {
                alert('Pedidos com NF-e emitida não podem ser editados.');
                return;
              }
              setIsEditOpen(true);
            }}
            disabled={!pedido}
            className="w-full sm:w-auto border-white/10 hover:bg-blue-500/10 hover:text-blue-400 hover:border-blue-500/30 text-slate-300 transition-colors">
            <Pencil className="w-4 h-4 mr-2" />
            Editar Pedido
          </Button>
          <Button 
            disabled={!pedido}
            className="w-full sm:w-auto bg-[#30D158] hover:bg-[#28B84E] text-[#0a0f1c] border border-[#30D158] font-bold shadow-lg shadow-[#30D158]/20 transition-all disabled:opacity-50">
            <Receipt className="w-4 h-4 mr-2" />
            Emitir NF-e
          </Button>
        </div>

        <ErrorLogModal 
          isOpen={errorLog.isOpen}
          onClose={() => setErrorLog(prev => ({ ...prev, isOpen: false }))}
          title={errorLog.message}
          errorMessage="Não foi possível apagar o pedido."
          details={errorLog.details}
          logs={errorLog.logs}
        />

      </DialogContent>

      <EditOrderModal 
        open={isEditOpen} 
        onOpenChange={setIsEditOpen} 
        pedido={pedido}
        onSuccess={() => {
          setIsEditOpen(false);
          // Recarregar o pedido atualizado
          setLoading(true);
          if (pedidoBlingId) fetchPedido(pedidoBlingId);
          // Evento para atualizar a listagem
          window.dispatchEvent(new CustomEvent('pedido-apagado')); 
        }} 
      />
    </Dialog>
  );
}
