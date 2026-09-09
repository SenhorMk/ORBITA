'use client';

import React from 'react';
import { Building2, ChevronDown, FileSpreadsheet, Loader2, Search, ShieldCheck } from 'lucide-react';

import { Modal, RodapeDeModal } from '@/components/ui/modal';

export interface Fornecedor {
  id: number;
  nome: string;
  fantasia?: string;
  numeroDocumento?: string;
}

/**
 * O `<form>` mora no corpo do diálogo e o botão de salvar mora no rodapé — são
 * irmãos, não pai e filho. O atributo `form` é o que liga os dois sem duplicar
 * o botão nem tirar o formulário da anatomia do Design System.
 */
const ID_DO_FORMULARIO = 'form-nova-despesa';

const ROTULO = 'text-xs font-semibold uppercase tracking-wider mb-1.5 block';
const COR_DO_ROTULO = { color: 'var(--txt2)' } as const;

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
        <label htmlFor="despesa-fornecedor" className="orbita-eyebrow">Fornecedor (Bling)</label>
        <button
          type="button"
          onClick={onCadastrarNovo}
          className="flex items-center gap-1 text-xs font-semibold cursor-pointer"
          style={{ color: 'var(--accent)' }}
        >
          <Building2 className="w-3 h-3" /> Cadastrar Novo
        </button>
      </div>
      <div className="relative" ref={dropdownRef}>
        <button
          type="button"
          id="despesa-fornecedor"
          onClick={() => setShowFornecedorDropdown(v => !v)}
          className="orbita-campo flex items-center justify-between cursor-pointer text-left"
        >
          <span className="truncate" style={{ color: fornecedorSelecionado ? 'var(--txt)' : 'var(--txt3)' }}>
            {fornecedorSelecionado ? fornecedorSelecionado.nome : 'Selecione um fornecedor...'}
          </span>
          <ChevronDown
            className={`w-4 h-4 shrink-0 transition-transform ${showFornecedorDropdown ? 'rotate-180' : ''}`}
            style={{ color: 'var(--txt3)' }}
          />
        </button>

        {showFornecedorDropdown && (
          <div
            className="absolute z-10 mt-1 w-full overflow-hidden"
            style={{ borderRadius: 'var(--r-card)', background: 'var(--head)', border: '1px solid var(--line)' }}
          >
            <div className="p-2" style={{ borderBottom: '1px solid var(--line)' }}>
              <div className="flex items-center gap-2 px-2">
                <Search className="w-4 h-4 shrink-0" style={{ color: 'var(--txt3)' }} />
                <input
                  ref={fornecedorSearchInputRef}
                  type="text"
                  placeholder="Buscar fornecedor..."
                  value={searchFornecedor}
                  onChange={e => setSearchFornecedor(e.target.value)}
                  className="flex-1 min-w-0 bg-transparent outline-none"
                  style={{ font: '400 13px/1 var(--font-archivo), sans-serif', color: 'var(--txt)' }}
                />
              </div>
            </div>
            <div className="max-h-52 overflow-y-auto py-1">
              {fornecedoresFiltrados.map(f => (
                <button
                  type="button"
                  key={f.id}
                  onClick={() => { setFornecedorSelecionado(f); setShowFornecedorDropdown(false); setSearchFornecedor(''); }}
                  className="w-full px-4 py-2.5 text-left cursor-pointer"
                  style={{ background: fornecedorSelecionado?.id === f.id ? 'var(--chip)' : 'transparent' }}
                >
                  <div style={{ font: '500 13px/1.3 var(--font-archivo), sans-serif', color: 'var(--txt)' }}>{f.nome}</div>
                  {f.fantasia && (
                    <div style={{ font: '400 11.5px/1.3 var(--font-archivo), sans-serif', color: 'var(--txt3)' }}>
                      {f.fantasia}
                    </div>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Um dos dois modos de lançamento — a escolha continua sendo entre Bling e Orbita. */
function BotaoDeModo({
  ativo,
  onClick,
  children,
}: {
  ativo: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={ativo}
      className="flex items-center justify-center gap-2 cursor-pointer"
      style={{
        minHeight: 36,
        padding: '0 10px',
        borderRadius: 11,
        font: '600 11.5px/1.2 var(--font-archivo), sans-serif',
        textAlign: 'center',
        background: ativo ? 'var(--txt)' : 'transparent',
        color: ativo ? 'var(--invTxt)' : 'var(--txt2)',
      }}
    >
      {children}
    </button>
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

/**
 * "Nova Despesa", no `Modal` do Design System.
 *
 * Isto é reskin: os campos são os mesmos (`descricao`, `valor`,
 * `data_vencimento`), com os mesmos `name`, as mesmas validações do navegador e
 * o mesmo `buildDespesaRequest` do outro lado. Os dois modos, o fornecedor
 * genérico, a busca e o caminho para cadastrar um fornecedor novo continuam
 * exatamente onde estavam.
 *
 * `dispensavel={false}` preserva o comportamento antigo: o diálogo anterior não
 * fechava por ESC nem por clique fora, e um formulário meio preenchido não pode
 * sumir por um clique errado.
 */
export function NovaDespesaModal({
  isOpen, onClose, modoLancamento, setModoLancamento, syncing, onSubmit, fornecedorPicker,
}: NovaDespesaModalProps) {
  return (
    <Modal
      aberto={isOpen}
      onAbertoChange={(aberto) => { if (!aberto) onClose(); }}
      tamanho="md"
      dispensavel={false}
      eyebrow="Financeiro"
      titulo="Registrar Nova Saída"
      descricao="Escolha se esta saída deve ser lançada na contabilidade oficial do Bling ou mantida apenas como auditoria interna."
      descricaoOculta={false}
      rodape={
        <RodapeDeModal
          secundaria={
            <button type="button" onClick={onClose} className="orbita-chip cursor-pointer">
              Cancelar
            </button>
          }
          primaria={
            <button
              type="submit"
              form={ID_DO_FORMULARIO}
              disabled={syncing}
              className="orbita-chip cursor-pointer"
              style={{ background: 'var(--accent)', borderColor: 'var(--accent)', color: 'var(--accent-fg)' }}
            >
              {syncing ? <><Loader2 className="w-4 h-4 animate-spin" /> Salvando...</> : 'Salvar Despesa'}
            </button>
          }
        />
      }
    >
      {/* Seletor de modo: contábil (Bling + Orbita) ou somente interno (Orbita). */}
      <div
        className="grid grid-cols-2 mb-5"
        style={{ gap: 3, padding: 4, borderRadius: 14, background: 'var(--chip)', border: '1px solid var(--line)' }}
      >
        <BotaoDeModo ativo={modoLancamento === 'contabil'} onClick={() => setModoLancamento('contabil')}>
          <FileSpreadsheet className="w-4 h-4 shrink-0" />
          Lançamento Contábil (Bling)
        </BotaoDeModo>
        <BotaoDeModo ativo={modoLancamento === 'interno'} onClick={() => setModoLancamento('interno')}>
          <ShieldCheck className="w-4 h-4 shrink-0" />
          Somente Interno (Orbita)
        </BotaoDeModo>
      </div>

      <form id={ID_DO_FORMULARIO} onSubmit={onSubmit} className="space-y-4">
        {/*
          Título e Descrição são campos distintos desde a migration 62. O
          título é opcional e **local**: o Bling não tem esse conceito, e é a
          descrição que continua indo para lá como `historico`.
        */}
        <div>
          <label htmlFor="despesa-titulo" className={ROTULO} style={COR_DO_ROTULO}>Título (opcional)</label>
          <input
            id="despesa-titulo"
            name="titulo"
            type="text"
            maxLength={120}
            className="orbita-campo"
            placeholder="Ex: Insumos, Frete, Aluguel..."
          />
        </div>

        <div>
          <label htmlFor="despesa-descricao" className={ROTULO} style={COR_DO_ROTULO}>Descrição do Gasto</label>
          <input
            id="despesa-descricao"
            name="descricao"
            required
            type="text"
            className="orbita-campo"
            placeholder="Ex: 1kg de Rapé, Frete Correios..."
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="despesa-valor" className={ROTULO} style={COR_DO_ROTULO}>Valor (R$)</label>
            <input
              id="despesa-valor"
              name="valor"
              required
              type="number"
              step="0.01"
              className="orbita-campo orbita-campo--mono"
              placeholder="0.00"
            />
          </div>
          <div>
            <label htmlFor="despesa-data-vencimento" className={ROTULO} style={COR_DO_ROTULO}>Data Vencimento</label>
            <input
              id="despesa-data-vencimento"
              name="data_vencimento"
              required
              type="date"
              defaultValue={new Date().toISOString().split('T')[0]}
              className="orbita-campo orbita-campo--mono"
            />
          </div>
        </div>

        {modoLancamento === 'contabil' && <FornecedorPicker {...fornecedorPicker} />}

        {modoLancamento === 'contabil' && (
          <p
            className="px-4 py-3 text-xs m-0"
            style={{ borderRadius: 'var(--r-card)', background: 'var(--chip)', border: '1px solid var(--line)', color: 'var(--txt2)' }}
          >
            A despesa será criada como <strong style={{ color: 'var(--txt)' }}>Em Aberto</strong> no Bling ERP,
            garantindo que apareça no painel contábil imediatamente.
          </p>
        )}

        {modoLancamento === 'interno' && (
          <p
            className="flex items-center gap-3 px-4 py-3 text-xs m-0"
            style={{ borderRadius: 'var(--r-card)', background: 'var(--chip)', border: '1px solid var(--line)', color: 'var(--txt2)' }}
          >
            <ShieldCheck className="w-5 h-5 shrink-0" style={{ color: 'var(--accent)' }} />
            <span>
              Lançamento armazenado com segurança no Orbita para sua auditoria de gestão de fluxo de caixa,
              sem alterar o Bling.
            </span>
          </p>
        )}
      </form>
    </Modal>
  );
}
