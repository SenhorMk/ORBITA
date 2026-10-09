'use client';

import React, { useEffect, useRef, useState } from 'react';

import {
  buildDespesaRequest,
  despesaRespostaSchema,
  resultadoNaoConfirmado,
} from '@/lib/config/despesaContract';
import { descreverErro } from '@/lib/erroLegivel';

import { NovaDespesaModal, type Fornecedor } from './NovaDespesaModal';
import { NovoFornecedorModal, type DadosCNPJ } from './NovoFornecedorModal';
import type { BuscaAutenticada, CategoriaFinanceira } from './useLeituraFinanceira';

const BRASILAPI_CNPJ_URL =
  process.env.NEXT_PUBLIC_BRASILAPI_CNPJ_URL || 'https://brasilapi.com.br/api/cnpj/v1';

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

/**
 * A operação contábil em curso neste diálogo: a chave nasce aqui, antes da
 * rede, e é reenviada enquanto o conteúdo for o mesmo. É o que faz uma
 * retentativa — inclusive depois de a resposta se perder no caminho — ser
 * reconhecida pelo servidor como a MESMA operação, sem uma segunda conta a
 * pagar no Bling.
 */
interface OperacaoEmCurso {
  readonly chave: string;
  /** O corpo enviado, sem a chave: conteúdo diferente é operação nova. */
  readonly corpo: string;
}

interface NovaDespesaSubmitInput {
  fetchWithAuth: BuscaAutenticada;
  modoLancamento: 'contabil' | 'interno';
  fornecedorSelecionado: Fornecedor | null;
  onSaved: () => void;
  operacao: { current: OperacaoEmCurso | null };
  /** O resultado não foi confirmado: o diálogo deixa de permitir reenvio. */
  onNaoConfirmado: (mensagem: string) => void;
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
    const contatoBlingId = Number.isSafeInteger(fornecedorId) && (fornecedorId ?? 0) > 0
      ? fornecedorId
      : undefined;
    const titulo = String(formData.get('titulo') ?? '').trim();
    const categoriaId = String(formData.get('categoriaId') ?? '').trim();
    payload = buildDespesaRequest({
      // O título é local: o Bling não tem esse campo, e a descrição continua
      // sendo o `historico` que vai para lá. Ele é obrigatório no formulário,
      // e continua opcional no contrato — a coluna nasceu nullable e os
      // registros anteriores a ela não podem ser invalidados.
      titulo: titulo === '' ? undefined : titulo,
      // A categoria é a que a pessoa escolheu, entre as reais da organização.
      // "Sem categoria" é uma resposta legítima, e não vira um id inventado.
      categoriaId: categoriaId === '' ? undefined : categoriaId,
      descricao: String(formData.get('descricao') ?? ''),
      valor: Number(formData.get('valor')),
      dataVencimento: String(formData.get('data_vencimento') ?? ''),
      modo: input.modoLancamento === 'interno' ? 'interno' : 'contabil',
      contatoBlingId,
      // O nome vai junto para o histórico da despesa saber quem foi o
      // fornecedor mesmo que o contato mude de nome no ERP. O id é a
      // referência; isto é um retrato.
      contatoNome: contatoBlingId === undefined ? undefined : input.fornecedorSelecionado?.nome,
    });
  } catch (erro: unknown) {
    alert(erro instanceof Error ? erro.message : 'Dados da despesa inválidos.');
    return;
  }

  if (payload.modo === 'contabil') {
    const corpo = JSON.stringify(payload);
    const anterior = input.operacao.current;
    const chave = anterior !== null && anterior.corpo === corpo ? anterior.chave : crypto.randomUUID();
    input.operacao.current = { chave, corpo };
    payload = { ...payload, chaveIdempotencia: chave };
  }

  let res: Response;
  try {
    res = await input.fetchWithAuth('/api/financeiro', {
      method: 'POST',
      body: JSON.stringify(payload),
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: unknown) {
    // A resposta se perdeu: o servidor pode ter lançado. A chave fica, e enviar
    // de novo o mesmo conteúdo é reconhecido como a mesma operação.
    console.error(err);
    alert(
      'Não foi possível confirmar se a despesa foi lançada (' + descreverErro(err) + '). '
        + 'Enviar de novo o mesmo lançamento reutiliza a mesma operação e não cria outra no Bling.',
    );
    return;
  }

  const lida = despesaRespostaSchema.safeParse(await res.json().catch(() => null));
  const resposta = lida.success ? lida.data : null;
  const estado = resposta?.operacao?.estado;

  if (estado !== undefined && resultadoNaoConfirmado(estado)) {
    input.onNaoConfirmado(resposta?.error ?? 'O resultado deste lançamento ainda não foi confirmado.');
    return;
  }
  // Recusa definitiva e conflito encerram a operação: a próxima submissão,
  // corrigida, é uma operação nova. `nao_enviada` mantém a chave — nada saiu.
  if (estado === 'recusada' || res.status === 409) input.operacao.current = null;

  if (!res.ok) {
    alert('Erro: ' + (resposta?.error || 'Falha ao salvar despesa'));
    return;
  }
  // Avisos são falhas parciais reais — por exemplo, a despesa foi lançada
  // no Bling mas continua em aberto lá porque a quitação falhou.
  if (resposta?.avisos && resposta.avisos.length > 0) {
    alert(resposta.avisos.join('\n'));
  }
  input.operacao.current = null;
  input.onSaved();
}


/**
 * O lançamento de despesa inteiro: os dois diálogos e a costura entre eles.
 *
 * Ele mora fora de `FinanceiroTab` porque o estado que sustenta esse fluxo —
 * modo do lançamento, lista de fornecedores, seleção, busca, consulta de CNPJ —
 * não tem nada a ver com ler o financeiro. O que a tela precisa saber é só
 * quando abriu, quando fechou e quando gravou.
 *
 * A costura preservada é esta: nova despesa → cadastrar fornecedor → salvar
 * fornecedor → volta para a despesa com o recém-criado já selecionado.
 */
export function LancamentoDeDespesa({
  fetchWithAuth,
  aberto,
  onFechar,
  onSalvo,
  syncing,
  setSyncing,
  categorias,
}: {
  fetchWithAuth: BuscaAutenticada;
  categorias: readonly CategoriaFinanceira[];
  aberto: boolean;
  onFechar: () => void;
  onSalvo: () => void;
  syncing: boolean;
  setSyncing: (valor: boolean) => void;
}) {
  const [isNovoFornecedorModalOpen, setIsNovoFornecedorModalOpen] = useState(false);
  // Modo de Lançamento (contabil = Bling+Orbita, interno = Apenas Orbita)
  const [modoLancamento, setModoLancamento] = useState<'contabil' | 'interno'>('contabil');
  const operacao = useRef<OperacaoEmCurso | null>(null);
  const [naoConfirmado, setNaoConfirmado] = useState<string | null>(null);

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
  });

  useEffect(() => {
    if (!aberto) return;
    let isMounted = true;
    void loadFornecedores(fetchWithAuth, () => isMounted, setFornecedores);
    return () => {
      isMounted = false;
    };
  }, [aberto, fetchWithAuth]);

  useEffect(() => {
    if (showFornecedorDropdown) {
      fornecedorSearchInputRef.current?.focus();
    }
  }, [showFornecedorDropdown]);

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

  const fornecedoresFiltrados = [
    { id: FORNECEDOR_GENERICO_ID, nome: '🛒 Fornecedor Genérico (Rápido)', fantasia: 'Para compras rápidas e gastos simples' },
    ...fornecedores.filter(f =>
      !searchFornecedor ||
      f.nome.toLowerCase().includes(searchFornecedor.toLowerCase()) ||
      (f.fantasia && f.fantasia.toLowerCase().includes(searchFornecedor.toLowerCase()))
    ),
  ];

  /**
   * O diálogo volta ao estado inicial ao FECHAR, e não ao abrir: reabrir não
   * pode herdar o modo nem o fornecedor da despesa anterior, e zerar aqui evita
   * um efeito que escreve estado no meio da renderização.
   */
  const fechar = () => {
    operacao.current = null;
    setNaoConfirmado(null);
    setModoLancamento('contabil');
    setFornecedorSelecionado(null);
    setSearchFornecedor('');
    onFechar();
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    setSyncing(true);
    try {
      await submitNovaDespesa(e, {
        fetchWithAuth,
        modoLancamento,
        fornecedorSelecionado,
        onSaved: () => {
          onSalvo();
          fechar();
        },
        operacao,
        onNaoConfirmado: setNaoConfirmado,
      });
    } finally {
      setSyncing(false);
    }
  };

  return (
    <>
      {/* Um de cada vez: o cadastro de fornecedor cobre a despesa e devolve
          para ela — nunca são dois diálogos empilhados. */}
      <NovaDespesaModal
        isOpen={aberto && !isNovoFornecedorModalOpen}
        onClose={fechar}
        modoLancamento={modoLancamento}
        setModoLancamento={setModoLancamento}
        syncing={syncing}
        naoConfirmado={naoConfirmado}
        onSubmit={handleSubmit}
        categorias={categorias}
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
          onCadastrarNovo: () => setIsNovoFornecedorModalOpen(true),
        }}
      />

      <NovoFornecedorModal
        isOpen={isNovoFornecedorModalOpen}
        onVoltar={() => { setIsNovoFornecedorModalOpen(false); resetCNPJState(); }}
        cnpj={cnpj}
        onCNPJChange={handleCNPJChange}
        dadosCNPJ={dadosCNPJ}
        buscandoCNPJ={buscandoCNPJ}
        erroCNPJ={erroCNPJ}
        salvandoFornecedor={salvandoFornecedor}
        onSalvar={salvarFornecedor}
      />
    </>
  );
}
