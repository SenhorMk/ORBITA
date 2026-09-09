'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { descreverErro } from '@/lib/erroLegivel';
import { executarSyncFinanceiro } from '@/lib/financeiroSync';

export type TipoDeTitulo = 'receber' | 'pagar';
export type SituacaoDeTitulo = 'aberto' | 'pago' | 'cancelado' | 'estornado';

export interface TituloFinanceiro {
  id: string;
  bling_id: number;
  tipo: TipoDeTitulo;
  situacao: SituacaoDeTitulo;
  valor: number;
  data_vencimento: string;
  data_pagamento?: string;
  /**
   * Nome curto da movimentação (migration 62). **Nulo** em tudo que veio do
   * Bling e em tudo lançado antes dela — a tela exibe a `descricao` no lugar,
   * como fallback de apresentação. Nada é gravado por esse fallback.
   */
  titulo?: string | null;
  descricao: string;
  categoria?: { descricao: string; cor?: string };
  /**
   * O pedido que originou este título (migration 61). É o vínculo estrutural
   * que substituiu a pista dentro do TEXTO da descrição — e é por ele, nunca
   * pelo texto, que a tela decide qual detalhe abrir.
   */
  pedido_id?: string | null;
  fornecedor_bling_id?: number | null;
  fornecedor_nome?: string | null;
}

export interface ResumoFinanceiro {
  receitas: number;
  despesas: number;
  saldo: number;
}

export type FiltroDeTipo = 'todos' | 'receber' | 'pagar';

export type BuscaAutenticada = (url: string, options?: RequestInit) => Promise<Response>;

/**
 * O que a requisição depende, e portanto a quem a resposta pertence.
 *
 * **O período não entra aqui de propósito.** Ele é recorte puro sobre a leitura
 * corrente — nunca cruza a rede —, então nenhuma leitura pode estar velha em
 * relação a ele: mudar o período recalcula o corte a partir do que já está na
 * tela. O `tipo`, esse sim, muda a consulta, e é por isso que ele carimba.
 */
type EscopoDeLeitura = FiltroDeTipo;

/** Um valor e o escopo que o produziu. Nada é exposto sem o carimbo bater. */
interface DoEscopo<T> {
  readonly escopo: EscopoDeLeitura;
  readonly valor: T;
}

/** Uma leitura boa: os títulos e o resumo que vieram juntos na mesma resposta. */
interface LeituraFinanceira {
  readonly titulos: TituloFinanceiro[];
  readonly resumo: ResumoFinanceiro;
}

/** Ou uma leitura boa, ou o motivo de não haver uma. Nunca as duas coisas. */
type Resultado =
  | { readonly ok: true; readonly leitura: LeituraFinanceira }
  | { readonly ok: false; readonly erro: string };

/**
 * O resumo, só quando a resposta traz os três números.
 *
 * O resumo é **autoridade do servidor** — a tela não o recalcula. Por isso ele
 * também não é completado com zeros: um corpo sem `resumo`, ou com um campo que
 * não é número, é uma leitura que não deu certo, e não uma organização sem
 * movimento. `R$ 0,00` só aparece quando o servidor disse zero.
 */
function lerResumo(valor: unknown): ResumoFinanceiro | null {
  if (typeof valor !== 'object' || valor === null) return null;
  const { receitas, despesas, saldo } = valor as Record<string, unknown>;
  if (typeof receitas !== 'number' || typeof despesas !== 'number' || typeof saldo !== 'number') {
    return null;
  }
  return { receitas, despesas, saldo };
}

/**
 * Uma leitura de `GET /api/financeiro`.
 *
 * `fetchWithAuth` devolve a `Response` sem lançar em não-2xx, então o `res.ok` e
 * o `success` do envelope são conferidos aqui: um 500 com `{ success: false }`
 * seguia o caminho do sucesso e a tela nunca ficava sabendo.
 */
async function buscarFinanceiro(
  fetchWithAuth: BuscaAutenticada,
  escopo: EscopoDeLeitura,
): Promise<Resultado> {
  const url = escopo === 'todos' ? '/api/financeiro' : `/api/financeiro?tipo=${escopo}`;
  try {
    const res = await fetchWithAuth(url);
    const corpo: unknown = await res.json().catch(() => null);
    const envelope = (typeof corpo === 'object' && corpo !== null ? corpo : {}) as {
      success?: unknown;
      error?: unknown;
      data?: { titulos?: unknown; resumo?: unknown };
    };
    const resumo = lerResumo(envelope.data?.resumo);

    if (!res.ok || envelope.success !== true || resumo === null) {
      return { ok: false, erro: descreverErro(envelope.error ?? `HTTP ${res.status}`) };
    }

    const titulos = Array.isArray(envelope.data?.titulos)
      ? (envelope.data.titulos as TituloFinanceiro[])
      : [];
    return { ok: true, leitura: { titulos, resumo } };
  } catch (err: unknown) {
    return { ok: false, erro: descreverErro(err) };
  }
}

/**
 * Carrega os títulos financeiros da organização.
 *
 * ## Zero e "não sei" são coisas diferentes
 *
 * A versão anterior começava em `{ receitas: 0, despesas: 0, saldo: 0 }` e o
 * `catch` só registrava o erro no console. O estado inicial continuava na tela,
 * e o lojista lia **R$ 0,00** onde a verdade era "não consegui carregar".
 * Enquanto não há leitura boa, não há resumo: a tela mostra carregando ou erro,
 * nunca números.
 *
 * ## E o dado de um filtro não vale por outro
 *
 * Toda leitura é **carimbada pelo escopo que a produziu**. Sem o carimbo, dois
 * defeitos reais apareciam:
 *
 * 1. **O vazamento entre filtros.** `Todos` carregava, o usuário ia para
 *    `Entradas`, a consulta de `Entradas` falhava — e a tela preservava a
 *    "última leitura boa", que era a de `Todos`, sob o rótulo `Entradas`. O
 *    aviso dizia que o dado envelheceu; ele não era velho, era de outra
 *    pergunta.
 * 2. **A resposta fora de ordem.** `Entradas` sai, o usuário troca para
 *    `Saídas`, `Saídas` responde, e só então `Entradas` responde: sem carimbo,
 *    a resposta atrasada sobrescreve a atual.
 *
 * Nada é exposto sem o carimbo bater com o escopo corrente, e nada é gravado
 * por uma resposta cujo escopo já não é o atual. Preservar a leitura boa num
 * refresh falhado continua valendo — dentro do **mesmo** escopo.
 */
export function useLeituraFinanceira(fetchWithAuth: BuscaAutenticada, ativo: boolean) {
  const [leitura, setLeitura] = useState<DoEscopo<LeituraFinanceira> | null>(null);
  const [erro, setErro] = useState<DoEscopo<string> | null>(null);
  const [syncing, setSyncing] = useState(false);
  /** Falha ou parcialidade da última sincronização, para a tela não mentir. */
  const [avisoSync, setAvisoSync] = useState('');
  const [filtroTipo, setFiltroTipo] = useState<FiltroDeTipo>('todos');
  /**
   * O escopo corrente, legível de dentro de uma resposta que ainda está em
   * voo. É o que permite descartar a resposta que chega depois da troca de
   * filtro sem recriar a leitura a cada renderização.
   */
  const escopoAtualRef = useRef<EscopoDeLeitura>(filtroTipo);

  const lerNoEscopo = useCallback(async (escopo: EscopoDeLeitura) => {
    const resultado = await buscarFinanceiro(fetchWithAuth, escopo);
    // Daqui para baixo é tudo escrita: se o carimbo não confere, esta resposta
    // é de outra pergunta e não tem onde ser aplicada.
    if (escopoAtualRef.current !== escopo) return;
    if (!resultado.ok) {
      setErro({ escopo, valor: resultado.erro });
      return;
    }
    setErro(null);
    setLeitura({ escopo, valor: resultado.leitura });
  }, [fetchWithAuth]);

  const fetchFinanceiro = useCallback(async () => {
    await lerNoEscopo(escopoAtualRef.current);
  }, [lerNoEscopo]);

  const syncFinanceiro = async () => {
    setSyncing(true);
    setAvisoSync('');
    try {
      setAvisoSync(await executarSyncFinanceiro(fetchWithAuth));
      // Recarrega de todo jeito: o que entrou antes da falha é dado bom.
      await fetchFinanceiro();
    } catch (err) {
      setAvisoSync(descreverErro(err));
    } finally {
      setSyncing(false);
    }
  };

  useEffect(() => {
    escopoAtualRef.current = filtroTipo;
    if (!ativo) return;
    // Disparada e esquecida: tudo o que ela grava acontece DEPOIS da resposta
    // do servidor, nunca durante o efeito.
    void (async () => {
      await lerNoEscopo(filtroTipo);
    })();
    // `ativo` entra na dependência de propósito: a aba fica montada o tempo
    // todo, então voltar a ela é o único momento em que releitura é pedida —
    // e é aí que uma venda manual registrada no painel precisa aparecer aqui.
  }, [lerNoEscopo, filtroTipo, ativo]);

  const valeAgora = leitura !== null && leitura.escopo === filtroTipo;
  const leituraAtual = valeAgora ? leitura.valor : null;
  const erroDeLeitura = erro !== null && erro.escopo === filtroTipo ? erro.valor : null;

  return {
    titulos: leituraAtual?.titulos ?? [],
    /** `null` enquanto nenhuma leitura DESTE escopo deu certo — nunca zeros de partida. */
    resumo: leituraAtual?.resumo ?? null,
    nuncaCarregou: leituraAtual === null,
    erroDeLeitura,
    /** Ainda não há leitura boa deste escopo e nada falhou nele. */
    carregando: leituraAtual === null && erroDeLeitura === null,
    syncing,
    setSyncing,
    avisoSync,
    filtroTipo,
    setFiltroTipo,
    fetchFinanceiro,
    syncFinanceiro,
  };
}
