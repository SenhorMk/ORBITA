'use client';

import { useState, useEffect, useDeferredValue } from "react";
import { GlassModal } from '@/components/ui/glass-modal';
import { Button } from '@/components/ui/button';
import { supabase } from '@/lib/supabaseClient';
import { Search, Plus, Trash2, CheckCircle2, Loader2, AlertCircle } from 'lucide-react';

interface ManualOrderModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

interface ClienteOption {
  id: string;
  nome: string;
  bling_id: string;
}

interface ProdutoOption {
  id: string;
  nome: string;
  codigo?: string;
  preco: number;
  estoque?: number;
  estoque_reservado?: number;
  bling_id: string;
}

interface ItemPedidoManual {
  produto_id: string;
  bling_id: string;
  nome: string;
  codigo?: string;
  quantidade: number;
  max_quantidade: number;
  valor_unitario: number;
}

export function ManualOrderModal({ open, onOpenChange, onSuccess }: ManualOrderModalProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form State
  const [syncBling, setSyncBling] = useState(true);
  const [clientes, setClientes] = useState<ClienteOption[]>([]);
  const [produtos, setProdutos] = useState<ProdutoOption[]>([]);
  const [selectedCliente, setSelectedCliente] = useState<string>('');
  const [formaPagamento, setFormaPagamento] = useState<string>('Dinheiro');
  const [itens, setItens] = useState<ItemPedidoManual[]>([]);

  // Detalhes Opcionais
  const [desconto, setDesconto] = useState<number | ''>('');
  const [frete, setFrete] = useState<number | ''>('');
  const [observacoes, setObservacoes] = useState<string>('');

  // Search terms
  const [searchProduto, setSearchProduto] = useState('');
  const deferredSearchProduto = useDeferredValue(searchProduto);

  useEffect(() => {
    let isMounted = true;
    if (open) {
      void (async () => {
        try {
          const { data: userRes } = await supabase.auth.getUser();
          if (!userRes.user || !isMounted) return;

          const [clientesRes, produtosRes] = await Promise.all([
            supabase.from('clientes').select('id, nome, bling_id').eq('user_id', userRes.user.id).order('nome'),
            supabase.from('produtos').select('id, nome, codigo, preco, estoque, estoque_reservado, bling_id').eq('user_id', userRes.user.id).order('nome'),
          ]);

          if (isMounted) {
            if (clientesRes.data) setClientes(clientesRes.data as ClienteOption[]);
            if (produtosRes.data) setProdutos(produtosRes.data as ProdutoOption[]);
          }
        } catch (err) {
          console.error(err);
        }
      })();
    }
    return () => {
      isMounted = false;
    };
  }, [open]);

  const addItem = (produtoId: string) => {
    const prod = produtos.find(p => p.id === produtoId);
    if (!prod) return;

    const available = (prod.estoque ?? 0) - (prod.estoque_reservado ?? 0);
    if (available <= 0) {
      setError(`Produto ${prod.nome} sem estoque disponível.`);
      return;
    }

    setItens(prev => {
      const existing = prev.find(i => i.produto_id === produtoId);
      if (existing) {
        if (existing.quantidade + 1 > available) {
          setError(`Estoque insuficiente para ${prod.nome}. Máx: ${available}`);
          return prev;
        }
        return prev.map(i => i.produto_id === produtoId ? { ...i, quantidade: i.quantidade + 1 } : i);
      }
      return [...prev, {
        produto_id: prod.id,
        nome: prod.nome,
        codigo: prod.codigo,
        valor_unitario: Number(prod.preco),
        quantidade: 1,
        max_quantidade: available,
        bling_id: prod.bling_id
      }];
    });
    setSearchProduto('');
    setError(null);
  };

  const updateItemQty = (produtoId: string, delta: number) => {
    setItens(prev => prev.map(i => {
      if (i.produto_id === produtoId) {
        const newQty = i.quantidade + delta;
        if (newQty > i.max_quantidade) {
          setError(`Estoque máximo para ${i.nome} é ${i.max_quantidade}`);
          return i;
        }
        if (newQty < 1) return i;
        return { ...i, quantidade: newQty };
      }
      return i;
    }));
  };

  const removeItem = (produtoId: string) => {
    setItens(prev => prev.filter(i => i.produto_id !== produtoId));
  };

  const calculateTotal = () => {
    return itens.reduce((acc, item) => acc + (item.quantidade * item.valor_unitario), 0);
  };

  const handleSubmit = async () => {
    if (!selectedCliente) {
      setError('Selecione um cliente.');
      return;
    }
    if (itens.length === 0) {
      setError('Adicione pelo menos um item ao pedido.');
      return;
    }

    setError(null);
    setLoading(true);

    try {
      const cliente = clientes.find(c => c.id === selectedCliente);

      const payload = {
        syncBling,
        contatoId: cliente?.bling_id || cliente?.id || selectedCliente,
        formaPagamento,

        total: calculateTotal(),
        desconto: Number(desconto) || 0,
        frete: Number(frete) || 0,
        observacoes,
        itens: itens.map(i => ({
          produto_id: i.produto_id,
          codigo: i.codigo || i.bling_id, // Fallback if no SKU
          quantidade: i.quantidade,
          valor_unitario: i.valor_unitario
        })),
        parcelas: [
          {
            formaPagamento: { id: formaPagamento === 'Dinheiro' ? 1 : 2 }, // Exemplo simples
            valor: calculateTotal()
          }
        ]
      };

      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;

      const res = await fetch('/api/pedidos/manual', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'Authorization': `Bearer ${token}` } : {})
        },
        body: JSON.stringify(payload)
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Falha ao processar pedido manual');
      }

      onSuccess?.();
      onOpenChange(false);
      setItens([]);
      setSelectedCliente('');
      setDesconto('');
      setFrete('');
      setObservacoes('');
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes('Informa\\u00e7\\u00f5es id\\u00eanticas a \\u00faltima venda salva') || errMsg.includes('code":3')) {
        setError('Erro: Venda Duplicada. Não é permitido enviar um pedido idêntico ao anterior (mesmo cliente, produtos e valores). Altere alguma informação ou aguarde se for intencional.');
      } else {
        setError(errMsg);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <GlassModal
      isOpen={open}
      onClose={() => onOpenChange(false)}
      title="Novo Pedido Manual (Loja Física)"
      subtitle="Crie um pedido para debitar estoque local e registrar finanças instantaneamente."
      icon={<Plus className="w-6 h-6 text-blue-400" />}
      footer={
        <>
          <div className="flex items-center gap-2 text-xs text-slate-400">
            {/* Espaço para status ou sincronização no footer */}
          </div>
          <div className="flex items-center gap-3">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading} className="bg-white/5 border-white/15 text-slate-300 hover:bg-white/10 rounded-2xl px-6">
              Cancelar
            </Button>
            <Button onClick={handleSubmit} disabled={loading || itens.length === 0 || !selectedCliente} className="glass-button-primary gap-2 bg-blue-600/80 hover:bg-blue-600 rounded-2xl px-6">
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
              Finalizar e Baixar Estoque
            </Button>
          </div>
        </>
      }
    >
        {error && (
          <div className="bg-rose-500/10 text-rose-400 p-4 rounded-2xl flex items-start gap-2 text-sm border border-rose-500/20 mb-6">
            <AlertCircle className="w-5 h-5 flex-shrink-0" />
            <span className="mt-0.5">{error}</span>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="space-y-5">
            <div>
              <label className="text-xs font-bold text-slate-300 uppercase tracking-wider block mb-1.5">Cliente</label>
              <select
                className="w-full px-4 py-2.5 rounded-2xl glass-input text-sm outline-none font-medium text-white bg-transparent [&>option]:bg-slate-900"
                value={selectedCliente}
                onChange={e => setSelectedCliente(e.target.value)}
              >
                <option value="">Selecione um cliente...</option>
                {clientes.map(c => (
                  <option key={c.id} value={c.id}>{c.nome}</option>
                ))}
              </select>
            </div>

            <div className="relative">
              <label className="text-xs font-bold text-slate-300 uppercase tracking-wider block mb-1.5">Buscar Produto</label>
              <div className="relative">
                <input
                  type="text"
                  placeholder="Nome ou SKU..."
                  className="w-full pl-11 pr-4 py-2.5 rounded-2xl glass-input text-sm outline-none font-medium text-white placeholder:text-slate-500"
                  value={searchProduto}
                  onChange={e => setSearchProduto(e.target.value)}
                />
                <Search className="w-4 h-4 text-slate-400 absolute left-4 top-3" />
              </div>

              {deferredSearchProduto.length > 1 && (
                <div className="mt-2 border border-white/10 rounded-2xl max-h-48 overflow-y-auto bg-slate-900/95 backdrop-blur-xl shadow-2xl absolute z-20 w-full overflow-hidden custom-scrollbar">
                  {produtos
                    .filter(p => p.nome.toLowerCase().includes(deferredSearchProduto.toLowerCase()) || p.codigo?.toLowerCase().includes(deferredSearchProduto.toLowerCase()))
                    .slice(0, 10)
                    .map(p => (
                    <div key={p.id} className="p-3 hover:bg-white/5 border-b border-white/5 flex justify-between items-center text-sm cursor-pointer transition-colors" onClick={() => addItem(p.id)}>
                      <div>
                        <p className="font-medium text-slate-200">{p.nome}</p>
                        <p className="text-xs text-slate-500">SKU: {p.codigo || 'N/A'} <span className="mx-1">•</span> Disp: {(p.estoque ?? 0) - (p.estoque_reservado ?? 0)}</p>
                      </div>
                      <Plus className="w-4 h-4 text-blue-400" />
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              <label className="text-xs font-bold text-slate-300 uppercase tracking-wider block mb-1.5">Forma de Pagamento</label>
              <select
                className="w-full px-4 py-2.5 rounded-2xl glass-input text-sm outline-none font-medium text-white bg-transparent [&>option]:bg-slate-900"
                value={formaPagamento}
                onChange={e => setFormaPagamento(e.target.value)}
              >
                <option value="Dinheiro">Dinheiro</option>
                <option value="PIX">PIX</option>
                <option value="Cartão de Crédito">Cartão de Crédito</option>
                <option value="Cartão de Débito">Cartão de Débito</option>
              </select>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-xs font-bold text-slate-300 uppercase tracking-wider block mb-1.5">Desconto (R$)</label>
                <input
                  type="number"
                  placeholder="0.00"
                  className="w-full px-4 py-2.5 rounded-2xl glass-input text-sm outline-none font-medium text-white placeholder:text-slate-500"
                  value={desconto}
                  onChange={e => setDesconto(e.target.value === '' ? '' : Number(e.target.value))}
                />
              </div>
              <div>
                <label className="text-xs font-bold text-slate-300 uppercase tracking-wider block mb-1.5">Frete (R$)</label>
                <input
                  type="number"
                  placeholder="0.00"
                  className="w-full px-4 py-2.5 rounded-2xl glass-input text-sm outline-none font-medium text-white placeholder:text-slate-500"
                  value={frete}
                  onChange={e => setFrete(e.target.value === '' ? '' : Number(e.target.value))}
                />
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4">
              <div>
                <label className="text-xs font-bold text-slate-300 uppercase tracking-wider block mb-1.5">Observações</label>
                <textarea
                  rows={2}
                  placeholder="Observações adicionais do pedido..."
                  className="w-full px-4 py-2.5 rounded-2xl glass-input text-sm outline-none resize-none font-medium text-white placeholder:text-slate-500"
                  value={observacoes}
                  onChange={e => setObservacoes(e.target.value)}
                />
              </div>
            </div>

            <div className="pt-2">
              <label className="flex items-center gap-3 text-sm cursor-pointer text-slate-300 font-medium hover:text-white transition-colors">
                <input type="checkbox" checked={syncBling} onChange={e => setSyncBling(e.target.checked)} className="w-4 h-4 rounded border-white/20 bg-white/5 text-blue-500 focus:ring-blue-500 focus:ring-offset-slate-900" />
                Sincronizar pedido com o Bling v3
              </label>
            </div>
          </div>

          <div className="border border-white/10 rounded-3xl p-6 bg-white/[0.02] flex flex-col h-full min-h-[400px]">
            <h3 className="text-sm font-bold text-slate-200 uppercase tracking-wider mb-4 border-b border-white/10 pb-3">Itens do Pedido</h3>

            <div className="flex-1 overflow-y-auto space-y-3 custom-scrollbar pr-2">
              {itens.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-center space-y-3 opacity-50">
                  <div className="w-16 h-16 rounded-full glass-card flex items-center justify-center">
                    <Search className="w-6 h-6 text-slate-400" />
                  </div>
                  <p className="text-sm font-medium text-slate-400">Nenhum item adicionado.<br/>Busque um produto ao lado.</p>
                </div>
              ) : (
                itens.map(item => (
                  <div key={item.produto_id} className="bg-white/[0.03] p-4 rounded-2xl border border-white/5 flex items-center justify-between hover:bg-white/5 transition-colors">
                    <div className="flex-1 min-w-0 pr-4">
                      <p className="text-sm font-bold text-slate-200 truncate">{item.nome}</p>
                      <p className="text-xs text-slate-500 font-mono mt-0.5">R$ {item.valor_unitario.toFixed(2)}</p>
                    </div>

                    <div className="flex items-center gap-3">
                      <div className="flex items-center glass-card rounded-xl border border-white/10 overflow-hidden">
                        <button onClick={() => updateItemQty(item.produto_id, -1)} className="px-3 py-1.5 text-slate-400 hover:text-white hover:bg-white/5 transition">-</button>
                        <span className="text-sm font-bold px-3 min-w-[2.5rem] text-center text-white border-x border-white/5">{item.quantidade}</span>
                        <button onClick={() => updateItemQty(item.produto_id, 1)} className="px-3 py-1.5 text-slate-400 hover:text-white hover:bg-white/5 transition">+</button>
                      </div>

                      <button onClick={() => removeItem(item.produto_id)} className="text-rose-400 hover:text-rose-300 hover:bg-rose-500/20 p-2.5 rounded-xl transition">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>

            <div className="mt-6 pt-4 border-t border-white/10 space-y-2">
              {(Number(desconto) > 0 || Number(frete) > 0) && (
                <>
                  <div className="flex justify-between items-center text-sm text-slate-400">
                    <span>Subtotal</span>
                    <span className="font-mono">R$ {calculateTotal().toFixed(2)}</span>
                  </div>
                  {Number(desconto) > 0 && (
                    <div className="flex justify-between items-center text-sm text-rose-400">
                      <span>Desconto</span>
                      <span className="font-mono">- R$ {Number(desconto).toFixed(2)}</span>
                    </div>
                  )}
                  {Number(frete) > 0 && (
                    <div className="flex justify-between items-center text-sm text-slate-400">
                      <span>Frete</span>
                      <span className="font-mono">+ R$ {Number(frete).toFixed(2)}</span>
                    </div>
                  )}
                  <div className="border-t border-white/5 my-2"></div>
                </>
              )}
              <div className="flex justify-between items-end pt-2">
                <div className="text-sm font-bold text-slate-400 uppercase tracking-wider">Total Líquido</div>
                <div className="text-2xl font-black text-white tracking-tight">
                  <span className="text-lg text-slate-500 mr-1">R$</span>
                  {Math.max(0, calculateTotal() - (Number(desconto) || 0) + (Number(frete) || 0)).toFixed(2)}
                </div>
              </div>
            </div>
          </div>
        </div>
    </GlassModal>
  );
}
