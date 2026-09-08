'use client';

import React, { useEffect, useRef, useState } from 'react';

import { buildDespesaRequest } from '@/lib/config/despesaContract';
import { descreverErro } from '@/lib/erroLegivel';

import { AcoesFinanceiras, AvisoSincronizacao } from './AcoesFinanceiras';
import { CabecalhoDoFinanceiro, CorpoDoFinanceiro } from './ComposicaoDoFinanceiro';
import { FiltroDeMovimentacoes } from './Movimentacoes';
import { NovaDespesaModal, type Fornecedor } from './NovaDespesaModal';
import { NovoFornecedorModal, type DadosCNPJ } from './NovoFornecedorModal';
import { useLeituraFinanceira, type BuscaAutenticada } from './useLeituraFinanceira';

const BRASILAPI_CNPJ_URL =
  process.env.NEXT_PUBLIC_BRASILAPI_CNPJ_URL || 'https://brasilapi.com.br/api/cnpj/v1';

interface FinanceiroTabProps {
  fetchWithAuth: BuscaAutenticada;
  /**
   * A aba está visível?
   *
   * A tela fica MONTADA o tempo todo (o painel só a esconde com `hidden`), e a
   * busca acontecia uma vez, no mount. Uma venda manual registrada depois disso
   * não aparecia aqui até recarregar a página — o Financeiro mostrava um saldo
   * mais velho que o do painel ao lado. Reler quando a aba volta a aparecer
   * resolve sem inventar polling.
   */
  ativo?: boolean;
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
  fetchWithAuth: BuscaAutenticada,
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
      alert('Erro: ' + (descreverErro(err)));
    } finally {
      setSalvandoFornecedor(false);
    }
  };

  return {
    cnpj, dadosCNPJ, buscandoCNPJ, erroCNPJ, salvandoFornecedor,
    handleCNPJChange, salvarFornecedor, resetCNPJState,
  };
}

/** Busca fornecedores cadastrados no Bling para popular o seletor da despesa contábil. */
async function loadFornecedores(
  fetchWithAuth: BuscaAutenticada,
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
  fetchWithAuth: BuscaAutenticada;
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
    alert('Erro inesperado: ' + (descreverErro(err)));
  }
}

/**
 * Controle Financeiro, na linguagem do produto novo.
 *
 * Isto é reskin. Os números são os mesmos: o resumo continua vindo pronto de
 * `GET /api/financeiro`, o fluxo de caixa continua somando os mesmos títulos
 * pelas mesmas datas, e cancelado e estornado continuam visíveis na lista e
 * fora dos totais. Nenhuma regra financeira foi recalculada aqui.
 *
 * O que mudou de comportamento é um defeito só, e ele é da tela: uma leitura
 * que falhava deixava os zeros do estado inicial no lugar dos números, e o
 * lojista lia **R$ 0,00** onde a verdade era "não consegui carregar". Agora
 * carregando, vazio e erro são três coisas diferentes — ver
 * `useLeituraFinanceira`.
 */
export function FinanceiroTab({ fetchWithAuth, ativo = true }: FinanceiroTabProps) {
  const {
    titulos, resumo, nuncaCarregou, erroDeLeitura, carregando,
    syncing, setSyncing, avisoSync, filtroTipo, setFiltroTipo,
    fetchFinanceiro, syncFinanceiro, chartData,
  } = useLeituraFinanceira(fetchWithAuth, ativo);

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

  const formatarDinheiro = (val: number) =>
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
    <div className="flex flex-col flex-1 min-h-0" style={{ gap: 'var(--conteudo-gap)' }}>

      <CabecalhoDoFinanceiro resumo={resumo} formatarDinheiro={formatarDinheiro} />

      <div className="flex items-center flex-none flex-wrap" style={{ gap: 10 }}>
        <FiltroDeMovimentacoes filtroTipo={filtroTipo} setFiltroTipo={setFiltroTipo} />
        <div className="flex-1" />
        <AcoesFinanceiras
          syncing={syncing}
          onSync={syncFinanceiro}
          onNovaDespesa={() => {
            setIsNovaDespesaModalOpen(true);
            setFornecedorSelecionado(null);
            setModoLancamento('contabil');
          }}
        />
      </div>

      <AvisoSincronizacao mensagem={avisoSync} />

      <CorpoDoFinanceiro
        estado={{ nuncaCarregou, erroDeLeitura, carregando }}
        titulos={titulos}
        chartData={chartData}
        formatarDinheiro={formatarDinheiro}
        onRecarregar={() => { void fetchFinanceiro(); }}
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
