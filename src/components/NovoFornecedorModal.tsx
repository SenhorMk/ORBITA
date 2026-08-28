'use client';

import React from 'react';
import { Building2, Loader2, CheckCircle, XCircle } from 'lucide-react';

export interface DadosCNPJ {
  razao_social: string;
  nome_fantasia: string;
  logradouro: string;
  numero: string;
  bairro: string;
  municipio: string;
  uf: string;
  cep: string;
  ddd_telefone_1?: string;
  email?: string;
  descricao_situacao_cadastral?: string;
}

interface NovoFornecedorModalProps {
  isOpen: boolean;
  onVoltar: () => void;
  cnpj: string;
  onCNPJChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  dadosCNPJ: DadosCNPJ | null;
  buscandoCNPJ: boolean;
  erroCNPJ: string;
  salvandoFornecedor: boolean;
  onSalvar: () => void;
}

const inputLocked = "w-full bg-zinc-800/70 border border-white/5 text-zinc-400 rounded-xl px-4 py-2.5 text-sm cursor-not-allowed select-none";
const inputBase = "w-full bg-black/40 border border-white/10 rounded-xl px-4 py-2.5 text-white focus:outline-none focus:border-blue-500 transition-colors text-sm";

/** Modal de cadastro de fornecedor via consulta automática de CNPJ (BrasilAPI + Bling). */
export function NovoFornecedorModal({
  isOpen, onVoltar, cnpj, onCNPJChange, dadosCNPJ, buscandoCNPJ, erroCNPJ, salvandoFornecedor, onSalvar,
}: NovoFornecedorModalProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div className="bg-zinc-900 border border-white/10 rounded-3xl p-6 w-full max-w-lg shadow-2xl animate-in zoom-in-95 duration-200">
        <div className="flex items-center gap-3 mb-1">
          <div className="w-10 h-10 rounded-xl bg-blue-500/10 flex items-center justify-center">
            <Building2 className="w-5 h-5 text-blue-400" />
          </div>
          <div>
            <h2 className="text-xl font-bold text-white">Cadastrar Fornecedor</h2>
            <p className="text-slate-400 text-xs">Preencha o CNPJ e deixamos a mágica rolar</p>
          </div>
        </div>

        <div className="mt-6 space-y-4">
          {/* CNPJ Input */}
          <div>
            <label htmlFor="fornecedor-cnpj" className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5 block">CNPJ</label>
            <div className="relative">
              <input
                id="fornecedor-cnpj"
                type="text"
                value={cnpj}
                onChange={onCNPJChange}
                maxLength={18}
                placeholder="00.000.000/0000-00"
                className={`${inputBase} pr-10`}
              />
              <div className="absolute right-3 top-1/2 -translate-y-1/2">
                {buscandoCNPJ && <Loader2 className="w-4 h-4 text-blue-400 animate-spin" />}
                {!buscandoCNPJ && dadosCNPJ && <CheckCircle className="w-4 h-4 text-[#30D158]" />}
                {!buscandoCNPJ && erroCNPJ && <XCircle className="w-4 h-4 text-[#FF453A]" />}
              </div>
            </div>
            {erroCNPJ && <p className="text-xs text-[#FF453A] mt-1">{erroCNPJ}</p>}
          </div>

          {/* Campos auto-preenchidos — sempre visíveis, bloqueados após busca */}
          <div>
            <label htmlFor="fornecedor-razao-social" className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5 block">Razão Social</label>
            <input id="fornecedor-razao-social" readOnly value={dadosCNPJ?.razao_social || ''} placeholder="Preenchido automaticamente" className={inputLocked} />
          </div>

          <div>
            <label htmlFor="fornecedor-nome-fantasia" className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5 block">Nome Fantasia</label>
            <input id="fornecedor-nome-fantasia" readOnly value={dadosCNPJ?.nome_fantasia || ''} placeholder="Preenchido automaticamente" className={inputLocked} />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <label htmlFor="fornecedor-logradouro" className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5 block">Logradouro</label>
              <input id="fornecedor-logradouro" readOnly value={dadosCNPJ ? `${dadosCNPJ.logradouro}, ${dadosCNPJ.numero}` : ''} placeholder="Rua, Número" className={inputLocked} />
            </div>
            <div>
              <label htmlFor="fornecedor-uf" className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5 block">UF</label>
              <input id="fornecedor-uf" readOnly value={dadosCNPJ?.uf || ''} placeholder="UF" className={inputLocked} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="fornecedor-municipio" className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5 block">Município</label>
              <input id="fornecedor-municipio" readOnly value={dadosCNPJ?.municipio || ''} placeholder="Preenchido automaticamente" className={inputLocked} />
            </div>
            <div>
              <label htmlFor="fornecedor-cep" className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5 block">CEP</label>
              <input id="fornecedor-cep" readOnly value={dadosCNPJ?.cep || ''} placeholder="Preenchido automaticamente" className={inputLocked} />
            </div>
          </div>

          {/* Indicador visual */}
          {dadosCNPJ && (
            <div className="flex items-center gap-2 bg-[#30D158]/10 border border-[#30D158]/20 rounded-xl px-4 py-2.5">
              <CheckCircle className="w-4 h-4 text-[#30D158] shrink-0" />
              <span className="text-xs text-[#30D158] font-medium">Dados verificados pela Receita Federal • Campos bloqueados para garantir integridade</span>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-3 mt-8">
          <button type="button"
            onClick={onVoltar}
            className="px-5 py-2.5 rounded-xl text-slate-300 font-medium hover:bg-white/5 transition-colors">
            Voltar
          </button>
          <button
            onClick={onSalvar}
            disabled={!dadosCNPJ || salvandoFornecedor}
            className="bg-gradient-to-r from-blue-600 to-blue-500 text-white px-6 py-2.5 rounded-xl font-bold shadow-lg transition-all hover:opacity-90 flex items-center gap-2 disabled:opacity-40">
            {salvandoFornecedor ? <><Loader2 className="w-4 h-4 animate-spin" /> Salvando no Bling...</> : <><Building2 className="w-4 h-4" /> Salvar Fornecedor</>}
          </button>
        </div>
      </div>
    </div>
  );
}
