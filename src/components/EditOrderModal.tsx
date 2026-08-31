'use client';

import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { supabase } from '@/lib/supabaseClient';
import { Search, Plus, Trash2, CheckCircle2, Loader2, AlertCircle } from 'lucide-react';

import { BlingPedido } from '@/types';
import { fetchWithAuth } from '@/lib/fetchWithAuth';
import { descreverErro } from '@/lib/erroLegivel';

interface EditOrderModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
  pedido: BlingPedido | null;
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

interface ItemPedidoEdit {
  produto_id: string;
  nome: string;
  codigo?: string;
  valor_unitario: number;
  quantidade: number;
  max_quantidade: number;
  bling_id?: string;
}

/** Mapeia os itens do pedido remoto (Bling) para o estado de edição local, casando por código/bling_id com o cadastro de produtos. */
function mapPedidoItensToEdit(pedidoItens: NonNullable<BlingPedido['itens']>, loadedProdutos: ProdutoOption[]): ItemPedidoEdit[] {
  return pedidoItens.map(item => {
    const prod = loadedProdutos.find(p => p.codigo === item.codigo || String(p.bling_id) === String(item.produto?.id));
    return {
      produto_id: prod?.id || item.codigo || 'unknown',
      nome: item.descricao || 'Produto sem descrição',
      codigo: item.codigo,
      valor_unitario: Number(item.valor || 0),
      quantidade: Number(item.quantidade || 1),
      max_quantidade: prod ? (Number(prod.estoque || 0) - Number(prod.estoque_reservado || 0) + Number(item.quantidade || 1)) : Number(item.quantidade || 1),
      bling_id: item.produto?.id ? String(item.produto.id) : undefined
    };
  });
}

interface EditOrderFormSetters {
  setClientes: (clientes: ClienteOption[]) => void;
  setProdutos: (produtos: ProdutoOption[]) => void;
  setSelectedCliente: (id: string) => void;
  setDesconto: (value: number | '') => void;
  setFrete: (value: number | '') => void;
  setObservacoes: (value: string) => void;
  setItens: (itens: ItemPedidoEdit[]) => void;
}

/** Carrega clientes/produtos disponíveis e, se houver um pedido para editar, hidrata o formulário com seus dados. */
async function loadEditOrderFormData(pedido: BlingPedido | null, setters: EditOrderFormSetters): Promise<void> {
  const [cRes, pRes] = await Promise.all([
    fetchWithAuth('/api/clientes'),
    fetchWithAuth('/api/produtos')
  ]);
  const cData = await cRes.json();
  const pData = await pRes.json();

  const loadedClientes: ClienteOption[] = cData.clientes || [];
  const loadedProdutos: ProdutoOption[] = pData.produtos || [];

  setters.setClientes(loadedClientes);
  setters.setProdutos(loadedProdutos);

  if (!pedido || loadedClientes.length === 0 || loadedProdutos.length === 0) return;

  const matchedCliente = loadedClientes.find(c => String(c.bling_id) === String(pedido.contato?.id));
  if (matchedCliente) setters.setSelectedCliente(matchedCliente.id);

  setters.setDesconto(pedido.desconto?.valor || '');
  setters.setFrete(pedido.transporte?.frete || '');
  setters.setObservacoes(pedido.observacoes || '');

  if (pedido.itens && pedido.itens.length > 0) {
    setters.setItens(mapPedidoItensToEdit(pedido.itens, loadedProdutos));
  }
}

interface BuildPedidoUpdatePayloadInput {
  pedido: BlingPedido | null;
  cliente: ClienteOption | undefined;
  observacoes: string;
  desconto: number | '';
  frete: number | '';
  itens: ItemPedidoEdit[];
}

/** Monta o payload PUT `/api/bling/pedidos/[id]` a partir do estado de edição do formulário. */
function buildPedidoUpdatePayload(input: BuildPedidoUpdatePayloadInput) {
  return {
    data: input.pedido?.data || new Date().toISOString().split('T')[0],
    numero: input.pedido?.numero,
    contato: {
      id: input.cliente?.bling_id
    },
    observacoes: input.observacoes,
    desconto: {
      valor: Number(input.desconto) || 0,
      unidade: 'REAL'
    },
    transporte: {
      frete: Number(input.frete) || 0
    },
    itens: input.itens.map(i => {
      const itemPayload: Record<string, unknown> = {
        descricao: i.nome || 'Produto sem nome',
        quantidade: Number(i.quantidade),
        valor: Number(i.valor_unitario)
      };

      if (i.bling_id) {
        itemPayload.produto = { id: Number(i.bling_id) };
      } else {
        // Só manda código se for item avulso
        itemPayload.codigo = i.codigo || '';
      }

      return itemPayload;
    })
  };
}

interface OrderItemsPanelProps {
  itens: ItemPedidoEdit[];
  desconto: number | '';
  frete: number | '';
  updateItemQty: (produtoId: string, delta: number) => void;
  removeItem: (produtoId: string) => void;
  calculateTotal: () => number;
}

/** Painel lateral com a lista de itens do pedido, controles de quantidade e o resumo de totais. */
function OrderItemsPanel({ itens, desconto, frete, updateItemQty, removeItem, calculateTotal }: OrderItemsPanelProps) {
  return (
    <div className="border rounded-md p-4 bg-gray-50 flex flex-col">
      <h3 className="font-medium text-gray-800 mb-4 border-b pb-2">Itens do Pedido</h3>

      <div className="flex-1 overflow-y-auto space-y-3 min-h-[200px]">
        {itens.length === 0 ? (
          <div className="text-center text-sm text-gray-400 py-10">
            Nenhum item adicionado
          </div>
        ) : (
          itens.map(item => (
            <div key={item.produto_id} className="bg-white p-3 rounded border shadow-sm flex items-center justify-between">
              <div className="flex-1">
                <p className="text-sm font-medium text-gray-800 truncate">{item.nome}</p>
                <p className="text-xs text-gray-500">R$ {item.valor_unitario.toFixed(2)}</p>
              </div>

              <div className="flex items-center gap-3">
                <div className="flex items-center border rounded">
                  <button onClick={() => updateItemQty(item.produto_id, -1)} className="px-2 py-1 text-gray-600 hover:bg-gray-100">-</button>
                  <span className="text-sm font-medium px-2 min-w-[2rem] text-center">{item.quantidade}</span>
                  <button onClick={() => updateItemQty(item.produto_id, 1)} className="px-2 py-1 text-gray-600 hover:bg-gray-100">+</button>
                </div>

                <button onClick={() => removeItem(item.produto_id)} className="text-red-500 hover:bg-red-50 p-1 rounded">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="mt-4 pt-4 border-t space-y-2">
        {(Number(desconto) > 0 || Number(frete) > 0) && (
          <>
            <div className="flex justify-between items-center text-sm text-gray-500">
              <span>Subtotal</span>
              <span>R$ {calculateTotal().toFixed(2)}</span>
            </div>
            {Number(desconto) > 0 && (
              <div className="flex justify-between items-center text-sm text-red-500">
                <span>Desconto</span>
                <span>- R$ {Number(desconto).toFixed(2)}</span>
              </div>
            )}
            {Number(frete) > 0 && (
              <div className="flex justify-between items-center text-sm text-gray-500">
                <span>Frete</span>
                <span>+ R$ {Number(frete).toFixed(2)}</span>
              </div>
            )}
            <div className="border-t pb-2"></div>
          </>
        )}
        <div className="flex justify-between items-end">
          <div className="text-sm text-gray-500 font-medium">Total Líquido</div>
          <div className="text-2xl font-bold text-gray-900">
            R$ {Math.max(0, calculateTotal() - (Number(desconto) || 0) + (Number(frete) || 0)).toFixed(2)}
          </div>
        </div>
      </div>
    </div>
  );
}

interface OrderFormFieldsProps {
  clientes: ClienteOption[];
  produtos: ProdutoOption[];
  selectedCliente: string;
  setSelectedCliente: (id: string) => void;
  searchProduto: string;
  setSearchProduto: (value: string) => void;
  addItem: (produtoId: string) => void;
  formaPagamento: string;
  setFormaPagamento: (value: string) => void;
  desconto: number | '';
  setDesconto: (value: number | '') => void;
  frete: number | '';
  setFrete: (value: number | '') => void;
  observacoes: string;
  setObservacoes: (value: string) => void;
  syncBling: boolean;
  setSyncBling: (value: boolean) => void;
}

/** Coluna esquerda do formulário: cliente, busca/adição de produto, forma de pagamento, desconto/frete e observações. */
function OrderFormFields(props: OrderFormFieldsProps) {
  const {
    clientes, produtos, selectedCliente, setSelectedCliente,
    searchProduto, setSearchProduto, addItem,
    formaPagamento, setFormaPagamento,
    desconto, setDesconto, frete, setFrete,
    observacoes, setObservacoes, syncBling, setSyncBling,
  } = props;

  return (
    <div className="space-y-4">
      <div>
        <label htmlFor="edit-order-cliente" className="text-sm font-medium text-gray-700 block mb-1">Cliente</label>
        <select
          id="edit-order-cliente"
          className="w-full border border-gray-300 rounded-md p-2 text-sm focus:ring-2 focus:ring-blue-500 outline-none"
          value={selectedCliente}
          onChange={e => setSelectedCliente(e.target.value)}
        >
          <option value="">Selecione um cliente...</option>
          {clientes.map(c => (
            <option key={c.id} value={c.id}>{c.nome}</option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="edit-order-buscar-produto" className="text-sm font-medium text-gray-700 block mb-1">Buscar Produto</label>
        <div className="relative">
          <input
            id="edit-order-buscar-produto"
            type="text"
            placeholder="Nome ou SKU..."
            className="w-full border border-gray-300 rounded-md p-2 pl-9 text-sm focus:ring-2 focus:ring-blue-500 outline-none"
            value={searchProduto}
            onChange={e => setSearchProduto(e.target.value)}
          />
          <Search className="w-4 h-4 text-gray-400 absolute left-3 top-3" />
        </div>

        {searchProduto.length > 1 && (
          <div className="mt-2 border rounded-md max-h-48 overflow-y-auto bg-white shadow-sm absolute z-10 w-full max-w-sm">
            {produtos
              .filter(p => p.nome.toLowerCase().includes(searchProduto.toLowerCase()) || p.codigo?.toLowerCase().includes(searchProduto.toLowerCase()))
              .slice(0, 10)
              .map(p => (
              <button
                type="button"
                key={p.id}
                className="w-full p-2 hover:bg-gray-50 border-b flex justify-between items-center text-sm cursor-pointer text-left"
                onClick={() => addItem(p.id)}
              >
                <div>
                  <p className="font-medium text-gray-800">{p.nome}</p>
                  <p className="text-xs text-gray-500">SKU: {p.codigo || 'N/A'} | Disp: {(p.estoque ?? 0) - (p.estoque_reservado ?? 0)}</p>
                </div>
                <Plus className="w-4 h-4 text-blue-500" />
              </button>
            ))}
          </div>
        )}
      </div>

      <div>
        <label htmlFor="edit-order-forma-pagamento" className="text-sm font-medium text-gray-700 block mb-1">Forma de Pagamento</label>
        <select
          id="edit-order-forma-pagamento"
          className="w-full border border-gray-300 rounded-md p-2 text-sm focus:ring-2 focus:ring-blue-500 outline-none"
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
          <label htmlFor="edit-order-desconto" className="text-sm font-medium text-gray-700 block mb-1">Desconto (R$)</label>
          <input
            id="edit-order-desconto"
            type="number"
            placeholder="0.00"
            className="w-full border border-gray-300 rounded-md p-2 text-sm focus:ring-2 focus:ring-blue-500 outline-none"
            value={desconto}
            onChange={e => setDesconto(e.target.value === '' ? '' : Number(e.target.value))}
          />
        </div>
        <div>
          <label htmlFor="edit-order-frete" className="text-sm font-medium text-gray-700 block mb-1">Frete (R$)</label>
          <input
            id="edit-order-frete"
            type="number"
            placeholder="0.00"
            className="w-full border border-gray-300 rounded-md p-2 text-sm focus:ring-2 focus:ring-blue-500 outline-none"
            value={frete}
            onChange={e => setFrete(e.target.value === '' ? '' : Number(e.target.value))}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="md:col-span-2">
          <label htmlFor="edit-order-observacoes" className="text-sm font-medium text-gray-700 block mb-1">Observações</label>
          <textarea
            id="edit-order-observacoes"
            rows={2}
            placeholder="Observações adicionais do pedido..."
            className="w-full border border-gray-300 rounded-md p-2 text-sm focus:ring-2 focus:ring-blue-500 outline-none resize-none"
            value={observacoes}
            onChange={e => setObservacoes(e.target.value)}
          />
        </div>
      </div>

      <div className="pt-2">
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input type="checkbox" checked={syncBling} onChange={e => setSyncBling(e.target.checked)} className="rounded text-blue-600 focus:ring-blue-500" />
          Sincronizar pedido imediatamente com o Bling v3
        </label>
      </div>
    </div>
  );
}

/** Gerencia a lista de itens do pedido em edição: adicionar, ajustar quantidade, remover e calcular o total. */
function useOrderItemsEditor(
  produtos: ProdutoOption[],
  setError: (message: string | null) => void,
  setSearchProduto: (value: string) => void,
) {
  const [itens, setItens] = useState<ItemPedidoEdit[]>([]);

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

  return { itens, setItens, addItem, updateItemQty, removeItem, calculateTotal };
}

export function EditOrderModal({ open, onOpenChange, onSuccess, pedido }: EditOrderModalProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncBling, setSyncBling] = useState(true);

  // Form State
  const [clientes, setClientes] = useState<ClienteOption[]>([]);
  const [produtos, setProdutos] = useState<ProdutoOption[]>([]);
  const [selectedCliente, setSelectedCliente] = useState<string>('');
  const [formaPagamento, setFormaPagamento] = useState<string>('Dinheiro');

  // Detalhes Opcionais
  const [desconto, setDesconto] = useState<number | ''>('');
  const [frete, setFrete] = useState<number | ''>('');
  const [observacoes, setObservacoes] = useState<string>('');

  // Search terms
  const [searchProduto, setSearchProduto] = useState('');

  const { itens, setItens, addItem, updateItemQty, removeItem, calculateTotal } = useOrderItemsEditor(produtos, setError, setSearchProduto);

  useEffect(() => {
    if (!open) return;

    let isMounted = true;
    void loadEditOrderFormData(pedido, {
      setClientes: (v) => { if (isMounted) setClientes(v); },
      setProdutos: (v) => { if (isMounted) setProdutos(v); },
      setSelectedCliente: (v) => { if (isMounted) setSelectedCliente(v); },
      setDesconto: (v) => { if (isMounted) setDesconto(v); },
      setFrete: (v) => { if (isMounted) setFrete(v); },
      setObservacoes: (v) => { if (isMounted) setObservacoes(v); },
      setItens: (v) => { if (isMounted) setItens(v); },
    }).catch((err) => console.error(err));

    return () => {
      isMounted = false;
    };
  }, [open, pedido, setItens]);

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
      const payload = buildPedidoUpdatePayload({ pedido, cliente, observacoes, desconto, frete, itens });

      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;

      if (!pedido) {
        throw new Error('ID do pedido original não encontrado para edição.');
      }

      const res = await fetchWithAuth(`/api/bling/pedidos/${pedido.id}`, {
        method: 'PUT',
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
      const errMsg = descreverErro(err);
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Editar Pedido</DialogTitle>
          <DialogDescription>Edite as informações do pedido. As alterações serão salvas diretamente no ERP.</DialogDescription>
        </DialogHeader>

        {error && (
          <div className="bg-red-50 text-red-600 p-4 rounded-md flex items-start gap-2 text-sm border border-red-100">
            <AlertCircle className="w-5 h-5 flex-shrink-0" />
            <span className="mt-0.5">{error}</span>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-4">
          <OrderFormFields
            clientes={clientes}
            produtos={produtos}
            selectedCliente={selectedCliente}
            setSelectedCliente={setSelectedCliente}
            searchProduto={searchProduto}
            setSearchProduto={setSearchProduto}
            addItem={addItem}
            formaPagamento={formaPagamento}
            setFormaPagamento={setFormaPagamento}
            desconto={desconto}
            setDesconto={setDesconto}
            frete={frete}
            setFrete={setFrete}
            observacoes={observacoes}
            setObservacoes={setObservacoes}
            syncBling={syncBling}
            setSyncBling={setSyncBling}
          />

          <OrderItemsPanel
            itens={itens}
            desconto={desconto}
            frete={frete}
            updateItemQty={updateItemQty}
            removeItem={removeItem}
            calculateTotal={calculateTotal}
          />
        </div>

        <div className="flex justify-end gap-3 mt-6">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button
            onClick={handleSubmit}
            disabled={loading}
            className="bg-blue-600 hover:bg-blue-700 text-white"
          >
            {loading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <CheckCircle2 className="w-4 h-4 mr-2" />}
            Salvar Alterações
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
