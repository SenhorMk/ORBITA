'use client';

import React, { useState, useEffect, useRef } from 'react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { Plus, ArrowDown, ArrowUp, RefreshCw, Building2, ChevronDown, Search, Loader2, CheckCircle, XCircle, ShieldCheck, FileSpreadsheet } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { ptBR } from 'date-fns/locale';

interface TituloFinanceiro {
  id: string;
  bling_id: number;
  tipo: 'receber' | 'pagar';
  situacao: 'aberto' | 'pago' | 'cancelado';
  valor: number;
  data_vencimento: string;
  data_pagamento?: string;
  descricao: string;
  categoria?: { descricao: string; cor?: string };
}

interface ResumoFinanceiro {
  receitas: number;
  despesas: number;
  saldo: number;
}

interface Fornecedor {
  id: number;
  nome: string;
  fantasia?: string;
  numeroDocumento?: string;
}

interface DadosCNPJ {
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

interface FinanceiroTabProps {
  fetchWithAuth: (url: string, options?: RequestInit) => Promise<Response>;
}

const FORNECEDOR_GENERICO_ID = -1;

export function FinanceiroTab({ fetchWithAuth }: FinanceiroTabProps) {
  const [titulos, setTitulos] = useState<TituloFinanceiro[]>([]);
  const [resumo, setResumo] = useState<ResumoFinanceiro>({ receitas: 0, despesas: 0, saldo: 0 });
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [filtroTipo, setFiltroTipo] = useState<'todos' | 'receber' | 'pagar'>('todos');
  
  // Modais
  const [isNovaDespesaModalOpen, setIsNovaDespesaModalOpen] = useState(false);
  const [isNovoFornecedorModalOpen, setIsNovoFornecedorModalOpen] = useState(false);

  // Modo de Lançamento (contabil = Bling+Orbita, interno = Apenas Orbita)
  const [modoLancamento, setModoLancamento] = useState<'contabil' | 'interno'>('contabil');

  // Fornecedores
  const [fornecedores, setFornecedores] = useState<Fornecedor[]>([]);
  const [fornecedorSelecionado, setFornecedorSelecionado] = useState<Fornecedor | null>(null);
  const [showFornecedorDropdown, setShowFornecedorDropdown] = useState(false);
  const [searchFornecedor, setSearchFornecedor] = useState('');
  const dropdownRef = useRef<HTMLDivElement>(null);
  
  // Estado do novo fornecedor via CNPJ
  const [cnpj, setCnpj] = useState('');
  const [dadosCNPJ, setDadosCNPJ] = useState<DadosCNPJ | null>(null);
  const [buscandoCNPJ, setBuscandoCNPJ] = useState(false);
  const [erroCNPJ, setErroCNPJ] = useState('');
  const [salvandoFornecedor, setSalvandoFornecedor] = useState(false);

  const fetchFinanceiro = async () => {
    setLoading(true);
    try {
      const url = filtroTipo === 'todos' ? '/api/financeiro' : `/api/financeiro?tipo=${filtroTipo}`;
      const res = await fetchWithAuth(url);
      const { data } = await res.json();
      if (data) {
        setTitulos(data.titulos || []);
        setResumo(data.resumo || { receitas: 0, despesas: 0, saldo: 0 });
      }
    } catch (err) {
      console.error('Erro ao buscar financeiro:', err);
    } finally {
      setLoading(false);
    }
  };

  const fetchFornecedores = async () => {
    try {
      const res = await fetchWithAuth('/api/financeiro/fornecedores');
      if (res.ok) {
        const { data } = await res.json();
        setFornecedores(data || []);
      }
    } catch (err) {
      console.error('Erro ao buscar fornecedores:', err);
    }
  };

  const syncFinanceiro = async () => {
    setSyncing(true);
    try {
      await fetchWithAuth('/api/financeiro/sync', { method: 'POST' });
      await fetchFinanceiro();
    } catch (err) {
      console.error('Erro ao sincronizar:', err);
    } finally {
      setSyncing(false);
    }
  };

  useEffect(() => {
    fetchFinanceiro();
  }, [filtroTipo]);

  useEffect(() => {
    if (isNovaDespesaModalOpen) {
      fetchFornecedores();
    }
  }, [isNovaDespesaModalOpen]);

  // Fechar dropdown ao clicar fora
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowFornecedorDropdown(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const formatCurrency = (val: number) =>
    new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(val);

  const formatCNPJ = (value: string) => {
    const digits = value.replace(/\D/g, '').slice(0, 14);
    return digits
      .replace(/^(\d{2})(\d)/, '$1.$2')
      .replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3')
      .replace(/\.(\d{3})(\d)/, '.$1/$2')
      .replace(/(\d{4})(\d)/, '$1-$2');
  };

  const buscarCNPJ = async (cnpjLimpo: string) => {
    if (cnpjLimpo.length < 14) return;
    setBuscandoCNPJ(true);
    setErroCNPJ('');
    setDadosCNPJ(null);
    try {
      const res = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${cnpjLimpo}`);
      if (!res.ok) {
        setErroCNPJ('CNPJ não encontrado na Receita Federal.');
        return;
      }
      const data: DadosCNPJ = await res.json();
      if (data.descricao_situacao_cadastral && !data.descricao_situacao_cadastral.includes('ATIVA')) {
        setErroCNPJ(`⚠️ Situação cadastral: ${data.descricao_situacao_cadastral}`);
      }
      setDadosCNPJ(data);
    } catch {
      setErroCNPJ('Erro ao consultar a Receita Federal. Tente novamente.');
    } finally {
      setBuscandoCNPJ(false);
    }
  };

  const handleCNPJChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const formatted = formatCNPJ(e.target.value);
    setCnpj(formatted);
    const limpo = formatted.replace(/\D/g, '');
    if (limpo.length === 14) buscarCNPJ(limpo);
    else {
      setDadosCNPJ(null);
      setErroCNPJ('');
    }
  };

  const salvarFornecedor = async () => {
    if (!dadosCNPJ) return;
    setSalvandoFornecedor(true);
    try {
      const res = await fetchWithAuth('/api/financeiro/fornecedores', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cnpj: cnpj.replace(/\D/g, ''),
          nome: dadosCNPJ.razao_social,
          nome_fantasia: dadosCNPJ.nome_fantasia,
          logradouro: dadosCNPJ.logradouro,
          numero: dadosCNPJ.numero,
          bairro: dadosCNPJ.bairro,
          municipio: dadosCNPJ.municipio,
          uf: dadosCNPJ.uf,
          cep: dadosCNPJ.cep,
          telefone: dadosCNPJ.ddd_telefone_1,
          email: dadosCNPJ.email,
        }),
      });
      const json = await res.json();
      if (json.success && json.data) {
        const novoFornecedor: Fornecedor = {
          id: json.data.id,
          nome: dadosCNPJ.razao_social,
          fantasia: dadosCNPJ.nome_fantasia,
          numeroDocumento: cnpj,
        };
        setFornecedores(prev => [novoFornecedor, ...prev]);
        setFornecedorSelecionado(novoFornecedor);
        setIsNovoFornecedorModalOpen(false);
        setIsNovaDespesaModalOpen(true);
        setCnpj(''); setDadosCNPJ(null); setErroCNPJ('');
      } else {
        alert('Erro ao salvar fornecedor: ' + (json.error || 'Desconhecido'));
      }
    } catch (err: any) {
      alert('Erro: ' + err.message);
    } finally {
      setSalvandoFornecedor(false);
    }
  };

  const chartData = titulos
    .filter(t => t.situacao === 'pago' || t.situacao === 'aberto')
    .reduce((acc: any[], curr) => {
      const date = curr.data_vencimento?.split('T')[0] || curr.data_vencimento;
      const existing = acc.find(d => d.date === date);
      if (existing) {
        if (curr.tipo === 'receber') existing.receitas += curr.valor;
        else existing.despesas += curr.valor;
      } else {
        acc.push({
          date,
          receitas: curr.tipo === 'receber' ? curr.valor : 0,
          despesas: curr.tipo === 'pagar' ? curr.valor : 0,
        });
      }
      return acc;
    }, [])
    .sort((a, b) => a.date.localeCompare(b.date));

  const fornecedoresFiltrados = [
    { id: FORNECEDOR_GENERICO_ID, nome: '🛒 Fornecedor Genérico (Rápido)', fantasia: 'Para compras rápidas e gastos simples' },
    ...fornecedores.filter(f =>
      !searchFornecedor ||
      f.nome.toLowerCase().includes(searchFornecedor.toLowerCase()) ||
      (f.fantasia && f.fantasia.toLowerCase().includes(searchFornecedor.toLowerCase()))
    ),
  ];

  const inputLocked = "w-full bg-zinc-800/70 border border-white/5 text-zinc-400 rounded-xl px-4 py-2.5 text-sm cursor-not-allowed select-none";
  const inputBase = "w-full bg-black/40 border border-white/10 rounded-xl px-4 py-2.5 text-white focus:outline-none focus:border-blue-500 transition-colors text-sm";

  return (
    <div className="p-6 space-y-6 h-full overflow-y-auto">
      {/* HEADER */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-white">Controle Financeiro</h2>
          <p className="text-slate-400 text-sm mt-0.5">Gestão simplificada de fluxo de caixa e saídas</p>
        </div>
        <div className="flex gap-3">
          <button
            onClick={syncFinanceiro}
            disabled={syncing}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-slate-300 text-sm font-medium transition-all"
          >
            <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
            {syncing ? 'Sincronizando...' : 'Sincronizar'}
          </button>
          <button
            onClick={() => {
              setIsNovaDespesaModalOpen(true);
              setFornecedorSelecionado(null);
              setModoLancamento('contabil');
            }}
            className="flex items-center gap-2 px-5 py-2 rounded-xl bg-gradient-to-r from-[#FF9F0A] to-[#FF6B00] text-zinc-900 text-sm font-bold shadow-lg hover:opacity-90 transition-all"
          >
            <Plus className="w-4 h-4" />
            Nova Despesa
          </button>
        </div>
      </div>

      {/* CARDS RESUMO */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: 'Total Entradas', value: resumo.receitas, color: '#30D158', icon: ArrowUp, bg: 'from-[#30D158]/10 to-transparent' },
          { label: 'Total Saídas', value: resumo.despesas, color: '#FF453A', icon: ArrowDown, bg: 'from-[#FF453A]/10 to-transparent' },
          { label: 'Saldo Líquido', value: resumo.saldo, color: resumo.saldo >= 0 ? '#30D158' : '#FF453A', icon: resumo.saldo >= 0 ? ArrowUp : ArrowDown, bg: 'from-blue-500/10 to-transparent' },
        ].map((card) => (
          <div key={card.label} className={`glass-panel p-5 rounded-3xl border border-white/10 bg-gradient-to-br ${card.bg}`}>
            <div className="flex items-center gap-3 mb-3">
              <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ backgroundColor: `${card.color}20` }}>
                <card.icon className="w-4 h-4" style={{ color: card.color }} />
              </div>
              <span className="text-slate-400 text-xs font-semibold uppercase tracking-wider">{card.label}</span>
            </div>
            <div className="text-2xl font-bold" style={{ color: card.color }}>
              {loading ? '...' : formatCurrency(card.value)}
            </div>
          </div>
        ))}
      </div>

      {/* GRÁFICO */}
      <div className="glass-panel p-6 rounded-3xl border border-white/10">
        <h3 className="text-white font-bold text-lg mb-4">Fluxo de Caixa</h3>
        <div style={{ height: 200 }}>
          <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 600, height: 200 }}>

            <AreaChart data={chartData} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
              <defs>
                <linearGradient id="colorReceita" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#30D158" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#30D158" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="colorDespesa" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#FF453A" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#FF453A" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" vertical={false} />
              <XAxis dataKey="date" stroke="#94a3b8" fontSize={12} tickLine={false} axisLine={false}
                tickFormatter={(val) => { if (!val) return ''; try { return format(parseISO(val), 'dd/MM'); } catch { return val; } }} />
              <YAxis stroke="#94a3b8" fontSize={12} tickLine={false} axisLine={false} tickFormatter={(val) => `R$${(val / 1000).toFixed(0)}k`} />
              <Tooltip contentStyle={{ backgroundColor: '#18181b', borderColor: 'rgba(255,255,255,0.1)', borderRadius: '1rem' }}
                labelFormatter={(val) => { try { return format(parseISO(val as string), "dd 'de' MMMM", { locale: ptBR }); } catch { return val; } }}
                formatter={(value: any) => [formatCurrency(Number(value || 0)), '']} />
              <Area type="monotone" dataKey="receitas" name="Entradas" stroke="#30D158" strokeWidth={3} fillOpacity={1} fill="url(#colorReceita)" />
              <Area type="monotone" dataKey="despesas" name="Saídas" stroke="#FF453A" strokeWidth={3} fillOpacity={1} fill="url(#colorDespesa)" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* LISTA DE TRANSAÇÕES */}
      <div className="glass-panel p-6 rounded-3xl border border-white/10">
        <div className="flex items-center justify-between mb-6">
          <h3 className="text-white font-bold text-lg">Últimas Movimentações</h3>
          <div className="flex bg-zinc-800/50 p-1 rounded-xl border border-white/5">
            {(['todos', 'receber', 'pagar'] as const).map((tipo) => (
              <button key={tipo}
                onClick={() => setFiltroTipo(tipo)}
                className={`px-3 py-1 text-xs font-medium rounded-lg transition-all ${
                  filtroTipo === tipo
                    ? tipo === 'todos' ? 'bg-zinc-700 text-white shadow-sm'
                      : tipo === 'receber' ? 'bg-[#30D158]/20 text-[#30D158] shadow-sm'
                      : 'bg-[#FF453A]/20 text-[#FF453A] shadow-sm'
                    : 'text-slate-400 hover:text-white'
                }`}>
                {tipo === 'todos' ? 'Todos' : tipo === 'receber' ? 'Entradas' : 'Saídas'}
              </button>
            ))}
          </div>
        </div>
        <div className="space-y-3">
          {loading ? (
            <div className="text-center py-10 text-slate-500 text-sm">Carregando movimentações...</div>
          ) : titulos.length === 0 ? (
            <div className="text-center py-10 text-slate-500 text-sm">Nenhuma movimentação encontrada.</div>
          ) : (
            titulos.slice(0, 10).map((titulo) => (
              <div key={titulo.id} className="flex items-center justify-between p-3 rounded-2xl bg-white/5 border border-white/5 hover:bg-white/10 transition-colors group">
                <div className="flex items-center gap-3">
                  <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${titulo.tipo === 'receber' ? 'bg-[#30D158]/10 text-[#30D158]' : 'bg-[#FF453A]/10 text-[#FF453A]'}`}>
                    {titulo.tipo === 'receber' ? <ArrowUp className="w-5 h-5" /> : <ArrowDown className="w-5 h-5" />}
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-white">{titulo.descricao}</div>
                    <div className="text-[11px] text-slate-400 font-medium">
                      {titulo.categoria?.descricao || 'Sem categoria'} •{' '}
                      {(() => { try { return format(parseISO(titulo.data_vencimento), 'dd/MM/yyyy'); } catch { return titulo.data_vencimento; } })()}
                      {titulo.bling_id === 0 && <span className="ml-2 text-zinc-500 font-mono">(Interno)</span>}
                    </div>
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className={`text-sm font-bold ${titulo.tipo === 'receber' ? 'text-[#30D158]' : 'text-white'}`}>
                    {titulo.tipo === 'receber' ? '+' : '-'}{formatCurrency(titulo.valor)}
                  </div>
                  <div className={`text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded-md inline-block mt-1 ${
                    titulo.situacao === 'pago' ? 'bg-[#30D158]/20 text-[#30D158]'
                      : titulo.situacao === 'cancelado' ? 'bg-zinc-700 text-zinc-300'
                      : 'bg-[#FF9F0A]/20 text-[#FF9F0A]'
                  }`}>
                    {titulo.situacao}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* ══════════════════════════════════════════════════
          MODAL — NOVA DESPESA (Contábil vs Interno)
      ══════════════════════════════════════════════════ */}
      {isNovaDespesaModalOpen && (
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

            <form onSubmit={async (e) => {
              e.preventDefault();
              const formData = new FormData(e.currentTarget);
              const vencimento = formData.get('data_vencimento') as string;
              
              const payload: any = {
                descricao: formData.get('descricao'),
                valor: formData.get('valor'),
                data_vencimento: vencimento,
                modo: modoLancamento,
                contato_id: fornecedorSelecionado?.id !== FORNECEDOR_GENERICO_ID ? fornecedorSelecionado?.id : undefined,
              };

              setSyncing(true);
              try {
                const res = await fetchWithAuth('/api/financeiro', {
                  method: 'POST',
                  body: JSON.stringify(payload),
                  headers: { 'Content-Type': 'application/json' },
                });
                if (!res.ok) {
                  const err = await res.json();
                  alert('Erro: ' + (err.error || 'Falha ao salvar despesa'));
                  return;
                }
                setIsNovaDespesaModalOpen(false);
                setFornecedorSelecionado(null);
                fetchFinanceiro();
              } catch (err: any) {
                console.error(err);
                alert('Erro inesperado: ' + err.message);
              } finally {
                setSyncing(false);
              }
            }}>
              <div className="space-y-4">
                {/* Descrição */}
                <div>
                  <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5 block">Descrição do Gasto</label>
                  <input name="descricao" required type="text" className={inputBase} placeholder="Ex: 1kg de Rapé, Frete Correios..." />
                </div>

                {/* Valor e Vencimento */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5 block">Valor (R$)</label>
                    <input name="valor" required type="number" step="0.01" className={inputBase} placeholder="0.00" />
                  </div>
                  <div>
                    <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5 block">Data Vencimento</label>
                    <input name="data_vencimento" required type="date" defaultValue={new Date().toISOString().split('T')[0]} className={inputBase} />
                  </div>
                </div>

                {/* Fornecedor Dropdown (Apenas no Modo Contábil ou opcional no Interno) */}
                {modoLancamento === 'contabil' && (
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Fornecedor (Bling)</label>
                      <button type="button"
                        onClick={() => { setIsNovoFornecedorModalOpen(true); setIsNovaDespesaModalOpen(false); }}
                        className="text-xs text-blue-400 hover:text-blue-300 transition-colors flex items-center gap-1">
                        <Building2 className="w-3 h-3" /> Cadastrar Novo
                      </button>
                    </div>
                    <div className="relative" ref={dropdownRef}>
                      <button type="button"
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
                                type="text"
                                placeholder="Buscar fornecedor..."
                                value={searchFornecedor}
                                onChange={e => setSearchFornecedor(e.target.value)}
                                className="flex-1 bg-transparent text-white text-sm outline-none placeholder:text-slate-600"
                                autoFocus
                              />
                            </div>
                          </div>
                          <div className="max-h-52 overflow-y-auto py-1">
                            {fornecedoresFiltrados.map(f => (
                              <button type="button" key={f.id}
                                onClick={() => { setFornecedorSelecionado(f as Fornecedor); setShowFornecedorDropdown(false); setSearchFornecedor(''); }}
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
                )}

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
                <button type="button" onClick={() => { setIsNovaDespesaModalOpen(false); setFornecedorSelecionado(null); }}
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
      )}

      {/* ══════════════════════════════════════════════════
          MODAL — CADASTRAR NOVO FORNECEDOR (CNPJ Mágico)
      ══════════════════════════════════════════════════ */}
      {isNovoFornecedorModalOpen && (
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
                <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5 block">CNPJ</label>
                <div className="relative">
                  <input
                    type="text"
                    value={cnpj}
                    onChange={handleCNPJChange}
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
                <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5 block">Razão Social</label>
                <input readOnly value={dadosCNPJ?.razao_social || ''} placeholder="Preenchido automaticamente" className={inputLocked} />
              </div>

              <div>
                <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5 block">Nome Fantasia</label>
                <input readOnly value={dadosCNPJ?.nome_fantasia || ''} placeholder="Preenchido automaticamente" className={inputLocked} />
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2">
                  <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5 block">Logradouro</label>
                  <input readOnly value={dadosCNPJ ? `${dadosCNPJ.logradouro}, ${dadosCNPJ.numero}` : ''} placeholder="Rua, Número" className={inputLocked} />
                </div>
                <div>
                  <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5 block">UF</label>
                  <input readOnly value={dadosCNPJ?.uf || ''} placeholder="UF" className={inputLocked} />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5 block">Município</label>
                  <input readOnly value={dadosCNPJ?.municipio || ''} placeholder="Preenchido automaticamente" className={inputLocked} />
                </div>
                <div>
                  <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5 block">CEP</label>
                  <input readOnly value={dadosCNPJ?.cep || ''} placeholder="Preenchido automaticamente" className={inputLocked} />
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
                onClick={() => {
                  setIsNovoFornecedorModalOpen(false);
                  setIsNovaDespesaModalOpen(true);
                  setCnpj(''); setDadosCNPJ(null); setErroCNPJ('');
                }}
                className="px-5 py-2.5 rounded-xl text-slate-300 font-medium hover:bg-white/5 transition-colors">
                Voltar
              </button>
              <button
                onClick={salvarFornecedor}
                disabled={!dadosCNPJ || salvandoFornecedor}
                className="bg-gradient-to-r from-blue-600 to-blue-500 text-white px-6 py-2.5 rounded-xl font-bold shadow-lg transition-all hover:opacity-90 flex items-center gap-2 disabled:opacity-40">
                {salvandoFornecedor ? <><Loader2 className="w-4 h-4 animate-spin" /> Salvando no Bling...</> : <><Building2 className="w-4 h-4" /> Salvar Fornecedor</>}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
