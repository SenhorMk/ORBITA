'use client';

import { useState, useEffect, useDeferredValue } from "react";
import { Modal, RodapeDeModal } from '@/components/ui/modal';
import { supabase } from '@/lib/supabaseClient';
import { Search, Plus, Trash2, CheckCircle2, Loader2, AlertCircle } from 'lucide-react';
import { useManualOrderSubmit, type ItemPedidoManual } from './useManualOrderSubmit';
import { PendenciasDeVendaManual } from './PendenciasDeVendaManual';

export type { ItemPedidoManual, UseManualOrderSubmitInput } from './useManualOrderSubmit';

interface ManualOrderModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
  /**
   * Organização ativa confirmada pelo servidor. Escopa a memória de
   * tentativas pendentes — ver
   * `tentativaPendente.ts` — e sem ela nada é lembrado entre instâncias.
   */
  organizacaoId: string | null;
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

/**
 * Carrega os clientes e produtos que a pessoa pode ver, para montar o formulário.
 *
 * A leitura roda no navegador, com o token da pessoa, então quem filtra é o RLS
 * do banco (`*_org_select`): aparecem as linhas das organizações de que ela é
 * membro — não só da ativa — e de qualquer membro, não só as que ela cadastrou.
 * Esta lista serve para escolher itens; ela não autoriza nada. No envio, o
 * servidor busca cliente, produtos e preços de novo dentro da organização
 * ativa verificada.
 */
async function loadManualOrderFormData(
  setClientes: (clientes: ClienteOption[]) => void,
  setProdutos: (produtos: ProdutoOption[]) => void,
): Promise<void> {
  const [clientesRes, produtosRes] = await Promise.all([
    // Contato excluído no Bling, ou com exclusão aguardando conferência (PRE-005),
    // não é oferecido; o servidor recusa de novo.
    supabase.from('clientes').select('id, nome, bling_id')
      .is('excluido_no_bling_em', null).is('exclusao_pendente_desde', null).order('nome'),
    // Só produtos vendáveis: arquivado ou inativo não é oferecido (o servidor recusa de novo).
    supabase.from('produtos').select('id, nome, codigo, preco, estoque, estoque_reservado, bling_id').eq('situacao', 'ativo').order('nome'),
  ]);

  if (clientesRes.data) setClientes(clientesRes.data as ClienteOption[]);
  if (produtosRes.data) setProdutos(produtosRes.data as ProdutoOption[]);
}

/**
 * Gerencia a lista de itens do pedido manual: adicionar, ajustar quantidade,
 * remover e calcular o total exibido. Esse total é só uma prévia na tela — o
 * valor gravado é recalculado no servidor com os preços do cadastro.
 */
function useManualOrderItems(
  produtos: ProdutoOption[],
  setError: (message: string | null) => void,
  setSearchProduto: (value: string) => void,
) {
  const [itens, setItens] = useState<ItemPedidoManual[]>([]);

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

interface ManualOrderFormFieldsProps {
  clientes: ClienteOption[];
  produtos: ProdutoOption[];
  selectedCliente: string;
  setSelectedCliente: (id: string) => void;
  searchProduto: string;
  setSearchProduto: (value: string) => void;
  deferredSearchProduto: string;
  addItem: (produtoId: string) => void;
  formaPagamento: string;
  setFormaPagamento: (value: string) => void;
  desconto: number | '';
  setDesconto: (value: number | '') => void;
  frete: number | '';
  setFrete: (value: number | '') => void;
  observacoes: string;
  setObservacoes: (value: string) => void;
}

/** Coluna esquerda do formulário: cliente, busca/adição de produto, forma de pagamento, desconto/frete e observações. */
function ManualOrderFormFields(props: ManualOrderFormFieldsProps) {
  const {
    clientes, produtos, selectedCliente, setSelectedCliente,
    searchProduto, setSearchProduto, deferredSearchProduto, addItem,
    formaPagamento, setFormaPagamento,
    desconto, setDesconto, frete, setFrete,
    observacoes, setObservacoes,
  } = props;

  return (
    <div className="space-y-5">
      <div>
        <label htmlFor="manual-order-cliente" className="text-xs font-bold text-slate-300 uppercase tracking-wider block mb-1.5">Cliente</label>
        <select
          id="manual-order-cliente"
          className="w-full px-4 py-2.5 rounded-2xl glass-input text-sm outline-none font-medium text-white bg-transparent"
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
        <label htmlFor="manual-order-buscar-produto" className="text-xs font-bold text-slate-300 uppercase tracking-wider block mb-1.5">Buscar Produto</label>
        <div className="relative">
          <input
            id="manual-order-buscar-produto"
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
              <button
                type="button"
                key={p.id}
                className="w-full p-3 hover:bg-white/5 border-b border-white/5 flex justify-between items-center text-sm cursor-pointer transition-colors text-left"
                onClick={() => addItem(p.id)}
              >
                <div>
                  <p className="font-medium text-slate-200">{p.nome}</p>
                  <p className="text-xs text-slate-500">SKU: {p.codigo || 'N/A'} <span className="mx-1">•</span> Disp: {(p.estoque ?? 0) - (p.estoque_reservado ?? 0)}</p>
                </div>
                <Plus className="w-4 h-4 text-blue-400" />
              </button>
            ))}
          </div>
        )}
      </div>

      <div>
        <label htmlFor="manual-order-forma-pagamento" className="text-xs font-bold text-slate-300 uppercase tracking-wider block mb-1.5">Forma de Pagamento</label>
        <select
          id="manual-order-forma-pagamento"
          className="w-full px-4 py-2.5 rounded-2xl glass-input text-sm outline-none font-medium text-white bg-transparent"
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
          <label htmlFor="manual-order-desconto" className="text-xs font-bold text-slate-300 uppercase tracking-wider block mb-1.5">Desconto (R$)</label>
          <input
            id="manual-order-desconto"
            type="number"
            placeholder="0.00"
            className="w-full px-4 py-2.5 rounded-2xl glass-input text-sm outline-none font-medium text-white placeholder:text-slate-500"
            value={desconto}
            onChange={e => setDesconto(e.target.value === '' ? '' : Number(e.target.value))}
          />
        </div>
        <div>
          <label htmlFor="manual-order-frete" className="text-xs font-bold text-slate-300 uppercase tracking-wider block mb-1.5">Frete (R$)</label>
          <input
            id="manual-order-frete"
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
          <label htmlFor="manual-order-observacoes" className="text-xs font-bold text-slate-300 uppercase tracking-wider block mb-1.5">Observações</label>
          <textarea
            id="manual-order-observacoes"
            rows={2}
            placeholder="Observações adicionais do pedido..."
            className="w-full px-4 py-2.5 rounded-2xl glass-input text-sm outline-none resize-none font-medium text-white placeholder:text-slate-500"
            value={observacoes}
            onChange={e => setObservacoes(e.target.value)}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * O interruptor que decide se esta venda **também** vira pedido no Bling.
 *
 * Vive no rodapé, ao lado da ação que ele modifica, e não dentro do corpo que
 * rola: em telas menores (1366×768) ele ficaria abaixo da dobra, e daria para
 * apertar "Finalizar e baixar estoque" sem ver que aquele clique escreve no
 * ERP. Ligado é o padrão para uma loja; a escolha fica visível na hora de
 * decidir.
 */
function SincronizarComOBling({
  syncBling,
  setSyncBling,
  desabilitado,
}: {
  syncBling: boolean;
  setSyncBling: (value: boolean) => void;
  desabilitado: boolean;
}) {
  return (
    <label className="flex items-center gap-2.5 text-sm cursor-pointer text-slate-300 font-medium hover:text-white transition-colors">
      <input
        type="checkbox"
        checked={syncBling}
        disabled={desabilitado}
        onChange={e => setSyncBling(e.target.checked)}
        className="w-4 h-4 rounded border-white/20 bg-white/5 text-blue-500 focus:ring-blue-500 focus:ring-offset-slate-900"
      />
      Sincronizar pedido com o Bling v3
    </label>
  );
}

interface ManualOrderItemsPanelProps {
  itens: ItemPedidoManual[];
  desconto: number | '';
  frete: number | '';
  updateItemQty: (produtoId: string, delta: number) => void;
  removeItem: (produtoId: string) => void;
  calculateTotal: () => number;
}

/** Painel lateral com a lista de itens do pedido manual, controles de quantidade e o resumo de totais. */
function ManualOrderItemsPanel({ itens, desconto, frete, updateItemQty, removeItem, calculateTotal }: ManualOrderItemsPanelProps) {
  return (
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
  );
}

/**
 * Modal de venda manual — o INÍCIO do fluxo de venda, no FRONTEND.
 *
 * Aqui a pessoa escolhe cliente, itens, desconto e frete. O total mostrado é só
 * uma prévia; nada daqui é autoridade.
 * PRÓXIMO PASSO: ao finalizar, `useManualOrderSubmit` monta o corpo pelo
 * contrato (`manualOrderContract.ts`) e chama `POST /api/pedidos/manual`.
 * Pendências de vendas sem desfecho aparecem em `PendenciasDeVendaManual`.
 */
export function ManualOrderModal({ open, onOpenChange, onSuccess, organizacaoId }: ManualOrderModalProps) {
  const [error, setError] = useState<string | null>(null);

  // Form State
  const [syncBling, setSyncBling] = useState(true);
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
  const deferredSearchProduto = useDeferredValue(searchProduto);

  const { itens, setItens, addItem, updateItemQty, removeItem, calculateTotal } = useManualOrderItems(produtos, setError, setSearchProduto);

  const { loading, handleSubmit } = useManualOrderSubmit({
    syncBling, selectedCliente, formaPagamento, desconto, frete, observacoes, itens,
    setError,
    onSuccess,
    onOpenChange,
    organizacaoId,
    resetForm: () => {
      setItens([]);
      setSelectedCliente('');
      setDesconto('');
      setFrete('');
      setObservacoes('');
    },
  });

  useEffect(() => {
    if (!open) return;
    // A abertura do modal só recarrega clientes e produtos; ela NÃO mexe na
    // referência de idempotência. Um envio anterior pode ter ficado
    // indeterminado, e reabrir o modal — ou recarregar a página — precisa
    // continuar apontando para a MESMA tentativa. `useManualOrderSubmit`
    // resolve a referência no envio, pelo fingerprint da venda, a partir das
    // pendências guardadas em `localStorage`, e só a esquece quando o
    // desfecho é conhecido.
    let isMounted = true;
    loadManualOrderFormData(
      (v) => { if (isMounted) setClientes(v); },
      (v) => { if (isMounted) setProdutos(v); },
    ).catch((err) => console.error(err));
    return () => {
      isMounted = false;
    };
  }, [open]);

  return (
    <Modal
      aberto={open}
      onAbertoChange={onOpenChange}
      tamanho="lg"
      eyebrow="Loja física"
      titulo="Novo pedido manual"
      descricao="Cria um pedido para debitar estoque local e registrar o financeiro."
      rodape={
        <RodapeDeModal
          esquerda={
            <SincronizarComOBling
              syncBling={syncBling}
              setSyncBling={setSyncBling}
              desabilitado={loading}
            />
          }
          secundaria={
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              disabled={loading}
              className="orbita-chip cursor-pointer"
            >
              Cancelar
            </button>
          }
          primaria={
            <button
              type="button"
              onClick={handleSubmit}
              disabled={loading || itens.length === 0 || !selectedCliente}
              className="orbita-chip cursor-pointer"
              style={{ background: 'var(--accent)', borderColor: 'var(--accent)', color: 'var(--accent-fg)' }}
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
              Finalizar e baixar estoque
            </button>
          }
        />
      }
    >
        <PendenciasDeVendaManual open={open} organizacaoId={organizacaoId} />

        {error && (
          <div className="bg-rose-500/10 text-rose-400 p-4 rounded-2xl flex items-start gap-2 text-sm border border-rose-500/20 mb-6">
            <AlertCircle className="w-5 h-5 flex-shrink-0" />
            <span className="mt-0.5">{error}</span>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <ManualOrderFormFields
            clientes={clientes}
            produtos={produtos}
            selectedCliente={selectedCliente}
            setSelectedCliente={setSelectedCliente}
            searchProduto={searchProduto}
            setSearchProduto={setSearchProduto}
            deferredSearchProduto={deferredSearchProduto}
            addItem={addItem}
            formaPagamento={formaPagamento}
            setFormaPagamento={setFormaPagamento}
            desconto={desconto}
            setDesconto={setDesconto}
            frete={frete}
            setFrete={setFrete}
            observacoes={observacoes}
            setObservacoes={setObservacoes}
          />

          <ManualOrderItemsPanel
            itens={itens}
            desconto={desconto}
            frete={frete}
            updateItemQty={updateItemQty}
            removeItem={removeItem}
            calculateTotal={calculateTotal}
          />
        </div>
    </Modal>
  );
}
