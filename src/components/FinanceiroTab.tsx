'use client';

import React, { useState, useEffect, useRef } from 'react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { Plus, ArrowDown, ArrowUp, RefreshCw } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { buildDespesaRequest } from '@/lib/config/despesaContract';
import { NovaDespesaModal, type Fornecedor } from './NovaDespesaModal';
import { NovoFornecedorModal, type DadosCNPJ } from './NovoFornecedorModal';

const BRASILAPI_CNPJ_URL =
  process.env.NEXT_PUBLIC_BRASILAPI_CNPJ_URL || 'https://brasilapi.com.br/api/cnpj/v1';

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

interface FinanceiroTabProps {
  fetchWithAuth: (url: string, options?: RequestInit) => Promise<Response>;
}

const FORNECEDOR_GENERICO_ID = -1;

function formatCNPJ(value: string): string {
  const digits = value.replace(/\D/g, '').slice(0, 14);
  return digits
    .replace(/^(\d{2})(\d)/, '$1.$2')
    .replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3')
    .replace(/\.(\d{3})(\d)/, '.$1/$2')
    .replace(/(\d{4})(\d)/, '$1-$2');
}

/** Estado e handlers do fluxo "cadastrar fornecedor via CNPJ" (consulta BrasilAPI + POST no Bling). */
function useFornecedorCadastro(
  fetchWithAuth: FinanceiroTabProps['fetchWithAuth'],
  searchFornecedor: string,
  onCadastrado: (novoFornecedor: Fornecedor) => void,
) {
  const [cnpj, setCnpj] = useState('');
  const [dadosCNPJ, setDadosCNPJ] = useState<DadosCNPJ | null>(null);
  const [buscandoCNPJ, setBuscandoCNPJ] = useState(false);
  const [erroCNPJ, setErroCNPJ] = useState('');
  const [salvandoFornecedor, setSalvandoFornecedor] = useState(false);

  const resetCNPJState = () => {
    setCnpj(''); setDadosCNPJ(null); setErroCNPJ('');
  };

  const buscarCNPJ = async (cnpjLimpo: string) => {
    if (cnpjLimpo.length < 14) return;
    setBuscandoCNPJ(true);
    setErroCNPJ('');
    setDadosCNPJ(null);
    try {
      const res = await fetch(`${BRASILAPI_CNPJ_URL}/${cnpjLimpo}`);
      if (!res.ok) {
        throw new Error('CNPJ não encontrado ou inválido na Receita Federal.');
      }
      const data = await res.json();
      setDadosCNPJ(data);
    } catch (err: unknown) {
      setErroCNPJ(err instanceof Error ? err.message : 'Falha ao consultar CNPJ');
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
    if (!dadosCNPJ && !searchFornecedor.trim()) {
      alert('Preencha o nome do fornecedor ou busque um CNPJ válido.');
      return;
    }

    setSalvandoFornecedor(true);
    try {
      const payload = {
        nome: dadosCNPJ ? (dadosCNPJ.nome_fantasia || dadosCNPJ.razao_social) : searchFornecedor.trim(),
        fantasia: dadosCNPJ?.nome_fantasia || undefined,
        cpf_cnpj: cnpj.replace(/\D/g, '') || undefined,
        telefone: dadosCNPJ?.ddd_telefone_1 || undefined,
        email: dadosCNPJ?.email || undefined,
        endereco: dadosCNPJ?.logradouro || undefined,
        numero: dadosCNPJ?.numero || undefined,
        bairro: dadosCNPJ?.bairro || undefined,
        cidade: dadosCNPJ?.municipio || undefined,
        uf: dadosCNPJ?.uf || undefined,
        cep: dadosCNPJ?.cep || undefined,
      };

      const res = await fetchWithAuth('/api/financeiro/fornecedores', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const json = await res.json();

      if (res.ok && json.data) {
        const novoFornecedor: Fornecedor = {
          id: json.data.bling_id || json.data.id,
          nome: json.data.nome,
          fantasia: json.data.fantasia,
          numeroDocumento: json.data.cpf_cnpj,
        };
        onCadastrado(novoFornecedor);
        resetCNPJState();
      } else {
        alert('Erro ao salvar fornecedor: ' + (json.error || 'Desconhecido'));
      }
    } catch (err: unknown) {
      alert('Erro: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSalvandoFornecedor(false);
    }
  };

  return {
    cnpj, dadosCNPJ, buscandoCNPJ, erroCNPJ, salvandoFornecedor,
    handleCNPJChange, salvarFornecedor, resetCNPJState,
  };
}

interface ResumoCardsProps {
  resumo: ResumoFinanceiro;
  loading: boolean;
  formatCurrency: (val: number) => string;
}

/** Cards de resumo: entradas, saídas e saldo líquido. */
function ResumoCards({ resumo, loading, formatCurrency }: ResumoCardsProps) {
  const cards = [
    { label: 'Total Entradas', value: resumo.receitas, color: '#30D158', icon: ArrowUp, bg: 'from-[#30D158]/10 to-transparent' },
    { label: 'Total Saídas', value: resumo.despesas, color: '#FF453A', icon: ArrowDown, bg: 'from-[#FF453A]/10 to-transparent' },
    { label: 'Saldo Líquido', value: resumo.saldo, color: resumo.saldo >= 0 ? '#30D158' : '#FF453A', icon: resumo.saldo >= 0 ? ArrowUp : ArrowDown, bg: 'from-blue-500/10 to-transparent' },
  ];

  return (
    <div className="grid grid-cols-3 gap-4">
      {cards.map((card) => (
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
  );
}

interface ChartDataPoint {
  date: string;
  receitas: number;
  despesas: number;
}

/** Gráfico de área "Fluxo de Caixa" (entradas vs. saídas ao longo do tempo). */
function FluxoCaixaChart({ chartData, formatCurrency }: { chartData: ChartDataPoint[]; formatCurrency: (val: number) => string }) {
  return (
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
              formatter={(value: unknown) => [formatCurrency(Number(value || 0)), '']} />
            <Area type="monotone" dataKey="receitas" name="Entradas" stroke="#30D158" strokeWidth={3} fillOpacity={1} fill="url(#colorReceita)" />
            <Area type="monotone" dataKey="despesas" name="Saídas" stroke="#FF453A" strokeWidth={3} fillOpacity={1} fill="url(#colorDespesa)" />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function formatDataVencimento(data: string): string {
  try {
    return format(parseISO(data), 'dd/MM/yyyy');
  } catch {
    return data;
  }
}

interface MovimentacoesListProps {
  loading: boolean;
  titulos: TituloFinanceiro[];
  filtroTipo: 'todos' | 'receber' | 'pagar';
  setFiltroTipo: (tipo: 'todos' | 'receber' | 'pagar') => void;
  formatCurrency: (val: number) => string;
}

/** Lista das últimas movimentações financeiras, com filtro por tipo (entradas/saídas). */
function MovimentacoesList({ loading, titulos, filtroTipo, setFiltroTipo, formatCurrency }: MovimentacoesListProps) {
  return (
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
                    {formatDataVencimento(titulo.data_vencimento)}
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
  );
}

/** Busca fornecedores cadastrados no Bling para popular o seletor da despesa contábil. */
async function loadFornecedores(
  fetchWithAuth: FinanceiroTabProps['fetchWithAuth'],
  isMounted: () => boolean,
  setFornecedores: (fornecedores: Fornecedor[]) => void,
): Promise<void> {
  try {
    const res = await fetchWithAuth('/api/financeiro/fornecedores');
    if (!res.ok) return;
    const { data } = await res.json();
    if (isMounted()) setFornecedores(data || []);
  } catch (err) {
    console.error('Erro ao buscar fornecedores:', err);
  }
}

interface NovaDespesaSubmitInput {
  fetchWithAuth: FinanceiroTabProps['fetchWithAuth'];
  modoLancamento: 'contabil' | 'interno';
  fornecedorSelecionado: Fornecedor | null;
  onSaved: () => void;
}

/** Envia o formulário de nova despesa (`/api/financeiro`) e trata o resultado. */
async function submitNovaDespesa(
  e: React.FormEvent<HTMLFormElement>,
  input: NovaDespesaSubmitInput,
): Promise<void> {
  e.preventDefault();
  const formData = new FormData(e.currentTarget);
  const fornecedorId = input.fornecedorSelecionado?.id !== FORNECEDOR_GENERICO_ID
    ? Number(input.fornecedorSelecionado?.id)
    : undefined;

  // Montado pelo contrato compartilhado com a rota. `valor` vira número aqui:
  // o `FormData` devolve string, e o schema oficial do Bling exige `float`.
  let payload;
  try {
    payload = buildDespesaRequest({
      descricao: String(formData.get('descricao') ?? ''),
      valor: Number(formData.get('valor')),
      dataVencimento: String(formData.get('data_vencimento') ?? ''),
      modo: input.modoLancamento === 'interno' ? 'interno' : 'contabil',
      contatoBlingId: Number.isSafeInteger(fornecedorId) && (fornecedorId ?? 0) > 0 ? fornecedorId : undefined,
    });
  } catch (erro: unknown) {
    alert(erro instanceof Error ? erro.message : 'Dados da despesa inválidos.');
    return;
  }

  try {
    const res = await input.fetchWithAuth('/api/financeiro', {
      method: 'POST',
      body: JSON.stringify(payload),
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) {
      const err = await res.json();
      alert('Erro: ' + (err.error || 'Falha ao salvar despesa'));
      return;
    }
    // Avisos são falhas parciais reais — por exemplo, a despesa foi lançada
    // no Bling mas continua em aberto lá porque a quitação falhou.
    const corpo = (await res.json()) as { avisos?: string[] };
    if (corpo.avisos && corpo.avisos.length > 0) {
      alert(corpo.avisos.join('\n'));
    }
    input.onSaved();
  } catch (err: unknown) {
    console.error(err);
    alert('Erro inesperado: ' + (err instanceof Error ? err.message : String(err)));
  }
}

/** Carrega/sincroniza os títulos financeiros e deriva os dados agregados (resumo + série do gráfico). */
function useFinanceiroResumo(fetchWithAuth: FinanceiroTabProps['fetchWithAuth']) {
  const [titulos, setTitulos] = useState<TituloFinanceiro[]>([]);
  const [resumo, setResumo] = useState<ResumoFinanceiro>({ receitas: 0, despesas: 0, saldo: 0 });
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [filtroTipo, setFiltroTipo] = useState<'todos' | 'receber' | 'pagar'>('todos');

  const fetchFinanceiro = React.useCallback(async (isMounted: () => boolean = () => true) => {
    setLoading(true);
    try {
      const url = filtroTipo === 'todos' ? '/api/financeiro' : `/api/financeiro?tipo=${filtroTipo}`;
      const res = await fetchWithAuth(url);
      const { data } = await res.json();
      if (isMounted() && data) {
        setTitulos(data.titulos || []);
        setResumo(data.resumo || { receitas: 0, despesas: 0, saldo: 0 });
      }
    } catch (err) {
      console.error('Erro ao buscar financeiro:', err);
    } finally {
      if (isMounted()) setLoading(false);
    }
  }, [filtroTipo, fetchWithAuth]);

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
    let isMounted = true;
    void (async () => {
      await fetchFinanceiro(() => isMounted);
    })();
    return () => {
      isMounted = false;
    };
  }, [fetchFinanceiro]);

  const chartData = titulos
    .filter(t => t.situacao === 'pago' || t.situacao === 'aberto')
    .reduce<ChartDataPoint[]>((acc, curr) => {
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

  return { titulos, resumo, loading, syncing, setSyncing, filtroTipo, setFiltroTipo, fetchFinanceiro, syncFinanceiro, chartData };
}

interface FinanceiroHeaderProps {
  syncing: boolean;
  onSync: () => void;
  onNovaDespesa: () => void;
}

/** Cabeçalho da aba financeira: título e ações (sincronizar / nova despesa). */
function FinanceiroHeader({ syncing, onSync, onNovaDespesa }: FinanceiroHeaderProps) {
  return (
    <div className="flex items-center justify-between">
      <div>
        <h2 className="text-2xl font-bold text-white">Controle Financeiro</h2>
        <p className="text-slate-400 text-sm mt-0.5">Gestão simplificada de fluxo de caixa e saídas</p>
      </div>
      <div className="flex gap-3">
        <button
          onClick={onSync}
          disabled={syncing}
          className="flex items-center gap-2 px-4 py-2 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-slate-300 text-sm font-medium transition-all"
        >
          <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
          {syncing ? 'Sincronizando...' : 'Sincronizar'}
        </button>
        <button
          onClick={onNovaDespesa}
          className="flex items-center gap-2 px-5 py-2 rounded-xl bg-gradient-to-r from-[#FF9F0A] to-[#FF6B00] text-zinc-900 text-sm font-bold shadow-lg hover:opacity-90 transition-all"
        >
          <Plus className="w-4 h-4" />
          Nova Despesa
        </button>
      </div>
    </div>
  );
}

export function FinanceiroTab({ fetchWithAuth }: FinanceiroTabProps) {
  const {
    titulos, resumo, loading, syncing, setSyncing, filtroTipo, setFiltroTipo,
    fetchFinanceiro, syncFinanceiro, chartData,
  } = useFinanceiroResumo(fetchWithAuth);

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
  const fornecedorSearchInputRef = useRef<HTMLInputElement>(null);

  const {
    cnpj, dadosCNPJ, buscandoCNPJ, erroCNPJ, salvandoFornecedor,
    handleCNPJChange, salvarFornecedor, resetCNPJState,
  } = useFornecedorCadastro(fetchWithAuth, searchFornecedor, (novoFornecedor) => {
    setFornecedores(prev => [novoFornecedor, ...prev]);
    setFornecedorSelecionado(novoFornecedor);
    setIsNovoFornecedorModalOpen(false);
    setIsNovaDespesaModalOpen(true);
  });

  useEffect(() => {
    if (showFornecedorDropdown) {
      fornecedorSearchInputRef.current?.focus();
    }
  }, [showFornecedorDropdown]);

  useEffect(() => {
    if (!isNovaDespesaModalOpen) return;
    let isMounted = true;
    void loadFornecedores(fetchWithAuth, () => isMounted, setFornecedores);
    return () => {
      isMounted = false;
    };
  }, [isNovaDespesaModalOpen, fetchWithAuth]);

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

  const fornecedoresFiltrados = [
    { id: FORNECEDOR_GENERICO_ID, nome: '🛒 Fornecedor Genérico (Rápido)', fantasia: 'Para compras rápidas e gastos simples' },
    ...fornecedores.filter(f =>
      !searchFornecedor ||
      f.nome.toLowerCase().includes(searchFornecedor.toLowerCase()) ||
      (f.fantasia && f.fantasia.toLowerCase().includes(searchFornecedor.toLowerCase()))
    ),
  ];

  const handleNovaDespesaSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    setSyncing(true);
    try {
      await submitNovaDespesa(e, {
        fetchWithAuth,
        modoLancamento,
        fornecedorSelecionado,
        onSaved: () => {
          setIsNovaDespesaModalOpen(false);
          setFornecedorSelecionado(null);
          fetchFinanceiro();
        },
      });
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="p-6 space-y-6 h-full overflow-y-auto">
      <FinanceiroHeader
        syncing={syncing}
        onSync={syncFinanceiro}
        onNovaDespesa={() => {
          setIsNovaDespesaModalOpen(true);
          setFornecedorSelecionado(null);
          setModoLancamento('contabil');
        }}
      />

      <ResumoCards resumo={resumo} loading={loading} formatCurrency={formatCurrency} />

      <FluxoCaixaChart chartData={chartData} formatCurrency={formatCurrency} />

      <MovimentacoesList
        loading={loading}
        titulos={titulos}
        filtroTipo={filtroTipo}
        setFiltroTipo={setFiltroTipo}
        formatCurrency={formatCurrency}
      />

      <NovaDespesaModal
        isOpen={isNovaDespesaModalOpen}
        onClose={() => { setIsNovaDespesaModalOpen(false); setFornecedorSelecionado(null); }}
        modoLancamento={modoLancamento}
        setModoLancamento={setModoLancamento}
        syncing={syncing}
        onSubmit={handleNovaDespesaSubmit}
        fornecedorPicker={{
          fornecedorSelecionado,
          showFornecedorDropdown,
          setShowFornecedorDropdown,
          dropdownRef,
          fornecedorSearchInputRef,
          searchFornecedor,
          setSearchFornecedor,
          fornecedoresFiltrados,
          setFornecedorSelecionado,
          onCadastrarNovo: () => { setIsNovoFornecedorModalOpen(true); setIsNovaDespesaModalOpen(false); },
        }}
      />

      <NovoFornecedorModal
        isOpen={isNovoFornecedorModalOpen}
        onVoltar={() => {
          setIsNovoFornecedorModalOpen(false);
          setIsNovaDespesaModalOpen(true);
          resetCNPJState();
        }}
        cnpj={cnpj}
        onCNPJChange={handleCNPJChange}
        dadosCNPJ={dadosCNPJ}
        buscandoCNPJ={buscandoCNPJ}
        erroCNPJ={erroCNPJ}
        salvandoFornecedor={salvandoFornecedor}
        onSalvar={salvarFornecedor}
      />
    </div>
  );
}
