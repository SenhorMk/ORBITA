'use client';

import React from 'react';
import { Building2, ChevronDown, Search, Loader2, ShieldCheck, FileSpreadsheet } from 'lucide-react';

export interface Fornecedor {
  id: number;
  nome: string;
  fantasia?: string;
  numeroDocumento?: string;
}

const inputBase = "w-full bg-black/40 border border-white/10 rounded-xl px-4 py-2.5 text-white focus:outline-none focus:border-blue-500 transition-colors text-sm";

interface FornecedorPickerProps {
  fornecedorSelecionado: Fornecedor | null;
  showFornecedorDropdown: boolean;
  setShowFornecedorDropdown: React.Dispatch<React.SetStateAction<boolean>>;
  dropdownRef: React.RefObject<HTMLDivElement | null>;
  fornecedorSearchInputRef: React.RefObject<HTMLInputElement | null>;
  searchFornecedor: string;
  setSearchFornecedor: (v: string) => void;
  fornecedoresFiltrados: Fornecedor[];
  setFornecedorSelecionado: (f: Fornecedor) => void;
  onCadastrarNovo: () => void;
}

/** Combobox de seleção de fornecedor (com busca) usado no lançamento contábil da despesa. */
function FornecedorPicker(props: FornecedorPickerProps) {
  const {
    fornecedorSelecionado, showFornecedorDropdown, setShowFornecedorDropdown, dropdownRef,
    fornecedorSearchInputRef, searchFornecedor, setSearchFornecedor, fornecedoresFiltrados,
    setFornecedorSelecionado, onCadastrarNovo,
  } = props;

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <label htmlFor="despesa-fornecedor" className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Fornecedor (Bling)</label>
        <button type="button"
          onClick={onCadastrarNovo}
          className="text-xs text-blue-400 hover:text-blue-300 transition-colors flex items-center gap-1">
          <Building2 className="w-3 h-3" /> Cadastrar Novo
        </button>
      </div>
      <div className="relative" ref={dropdownRef}>
        <button type="button"
          id="despesa-fornecedor"
          onClick={() => setShowFornecedorDropdown(v => !v)}
          className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white flex items-center justify-between hover:border-white/20 transition-colors">
          <span className={fornecedorSelecionado ? 'text-white' : 'text-slate-500'}>
            {fornecedorSelecionado ? fornecedorSelecionado.nome : 'Selecione um fornecedor...'}
          </span>
          <ChevronDown className={`w-4 h-4 text-slate-400 transition-transform ${showFornecedorDropdown ? 'rotate-180' : ''}`} />
        </button>

        {showFornecedorDropdown && (
          <div className="absolute z-10 mt-1 w-full bg-zinc-900 border border-white/10 rounded-2xl shadow-2xl overflow-hidden">
            <div className="p-2 border-b border-white/5">
              <div className="flex items-center gap-2 px-2">
                <Search className="w-4 h-4 text-slate-500" />
                <input
                  ref={fornecedorSearchInputRef}
                  type="text"
                  placeholder="Buscar fornecedor..."
                  value={searchFornecedor}
                  onChange={e => setSearchFornecedor(e.target.value)}
                  className="flex-1 bg-transparent text-white text-sm outline-none placeholder:text-slate-600"
                />
              </div>
            </div>
            <div className="max-h-52 overflow-y-auto py-1">
              {fornecedoresFiltrados.map(f => (
                <button type="button" key={f.id}
                  onClick={() => { setFornecedorSelecionado(f); setShowFornecedorDropdown(false); setSearchFornecedor(''); }}
                  className={`w-full px-4 py-2.5 text-left hover:bg-white/5 transition-colors ${fornecedorSelecionado?.id === f.id ? 'bg-blue-500/10' : ''}`}>
                  <div className="text-sm text-white font-medium">{f.nome}</div>
                  {f.fantasia && <div className="text-xs text-slate-500">{f.fantasia}</div>}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

interface NovaDespesaModalProps {
  isOpen: boolean;
  onClose: () => void;
  modoLancamento: 'contabil' | 'interno';
  setModoLancamento: (modo: 'contabil' | 'interno') => void;
  syncing: boolean;
  onSubmit: (e: React.FormEvent<HTMLFormElement>) => void;
  fornecedorPicker: FornecedorPickerProps;
}

/** Modal "Nova Despesa": alterna entre lançamento contábil (Bling) e somente interno (Orbita). */
export function NovaDespesaModal({
  isOpen, onClose, modoLancamento, setModoLancamento, syncing, onSubmit, fornecedorPicker,
}: NovaDespesaModalProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div className="bg-zinc-900 border border-white/10 rounded-3xl p-6 w-full max-w-lg shadow-2xl animate-in zoom-in-95 duration-200">
        <h2 className="text-xl font-bold text-white mb-1">Registrar Nova Saída</h2>
        <p className="text-slate-400 text-xs mb-5">Escolha se esta saída deve ser lançada na contabilidade oficial do Bling ou mantida apenas como auditoria interna.</p>

        {/* SELETOR DE MODO (Contábil vs Interno) */}
        <div className="grid grid-cols-2 gap-3 mb-6 p-1 bg-black/40 border border-white/10 rounded-2xl">
          <button
            type="button"
            onClick={() => setModoLancamento('contabil')}
            className={`flex items-center justify-center gap-2 py-2.5 rounded-xl font-semibold text-xs transition-all ${
              modoLancamento === 'contabil'
                ? 'bg-blue-600 text-white shadow-lg'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <FileSpreadsheet className="w-4 h-4" />
            Lançamento Contábil (Bling)
          </button>
          <button
            type="button"
            onClick={() => setModoLancamento('interno')}
            className={`flex items-center justify-center gap-2 py-2.5 rounded-xl font-semibold text-xs transition-all ${
              modoLancamento === 'interno'
                ? 'bg-zinc-700 text-white shadow-lg'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <ShieldCheck className="w-4 h-4" />
            Somente Interno (Orbita)
          </button>
        </div>

        <form onSubmit={onSubmit}>
          <div className="space-y-4">
            {/* Descrição */}
            <div>
              <label htmlFor="despesa-descricao" className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5 block">Descrição do Gasto</label>
              <input id="despesa-descricao" name="descricao" required type="text" className={inputBase} placeholder="Ex: 1kg de Rapé, Frete Correios..." />
            </div>

            {/* Valor e Vencimento */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="despesa-valor" className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5 block">Valor (R$)</label>
                <input id="despesa-valor" name="valor" required type="number" step="0.01" className={inputBase} placeholder="0.00" />
              </div>
              <div>
                <label htmlFor="despesa-data-vencimento" className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5 block">Data Vencimento</label>
                <input id="despesa-data-vencimento" name="data_vencimento" required type="date" defaultValue={new Date().toISOString().split('T')[0]} className={inputBase} />
              </div>
            </div>

            {/* Fornecedor Dropdown (Apenas no Modo Contábil ou opcional no Interno) */}
            {modoLancamento === 'contabil' && <FornecedorPicker {...fornecedorPicker} />}

            {/* Info Note para Lançamento Contábil */}
            {modoLancamento === 'contabil' && (
              <div className="p-3 bg-blue-500/10 border border-blue-500/20 rounded-2xl text-xs text-blue-300 font-medium">
                💡 A despesa será criada como <strong>Em Aberto</strong> no Bling ERP, garantindo que apareça no painel contábil imediatamente.
              </div>
            )}

            {/* Informação do Modo Interno */}
            {modoLancamento === 'interno' && (
              <div className="p-3.5 bg-zinc-800/60 border border-white/5 rounded-2xl flex items-center gap-3 text-xs text-slate-400">
                <ShieldCheck className="w-5 h-5 text-emerald-400 shrink-0" />
                <span>Lançamento armazenado com segurança no Orbita para sua auditoria de gestão de fluxo de caixa, sem alterar o Bling.</span>
              </div>
            )}
          </div>

          <div className="flex justify-end gap-3 mt-8">
            <button type="button" onClick={onClose}
              className="px-5 py-2.5 rounded-xl text-slate-300 font-medium hover:bg-white/5 transition-colors">
              Cancelar
            </button>
            <button type="submit" disabled={syncing}
              className="bg-gradient-to-r from-[#FF9F0A] to-[#FF6B00] text-zinc-900 px-6 py-2.5 rounded-xl font-bold shadow-lg transition-all hover:opacity-90 flex items-center gap-2 disabled:opacity-50">
              {syncing ? <><Loader2 className="w-4 h-4 animate-spin" /> Salvando...</> : 'Salvar Despesa'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
