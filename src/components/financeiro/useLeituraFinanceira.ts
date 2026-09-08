'use client';

import { useCallback, useEffect, useState } from 'react';

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
  descricao: string;
  categoria?: { descricao: string; cor?: string };
}

export interface ResumoFinanceiro {
  receitas: number;
  despesas: number;
  saldo: number;
}

export interface PontoDoFluxo {
  date: string;
  receitas: number;
  despesas: number;
}

export type FiltroDeTipo = 'todos' | 'receber' | 'pagar';

export type BuscaAutenticada = (url: string, options?: RequestInit) => Promise<Response>;

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
  filtroTipo: FiltroDeTipo,
): Promise<Resultado> {
  const url = filtroTipo === 'todos' ? '/api/financeiro' : `/api/financeiro?tipo=${filtroTipo}`;
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
 * A série do fluxo de caixa, somada por data de vencimento.
 *
 * Terminal fica fora do fluxo pelo mesmo motivo que fica fora do total: não é
 * dinheiro que entrou nem que vai entrar. A regra e a agregação são as de
 * antes, sem nenhum recorte novo.
 */
function derivarFluxo(titulos: readonly TituloFinanceiro[]): PontoDoFluxo[] {
  return titulos
    .filter((t) => t.situacao === 'pago' || t.situacao === 'aberto')
    .reduce<PontoDoFluxo[]>((acc, curr) => {
      const date = curr.data_vencimento?.split('T')[0] || curr.data_vencimento;
      const existing = acc.find((d) => d.date === date);
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
}

/**
 * Carrega os títulos financeiros e deriva a série do fluxo de caixa.
 *
 * ## Zero e "não sei" são coisas diferentes
 *
 * A versão anterior começava em `{ receitas: 0, despesas: 0, saldo: 0 }` e, no
 * `catch`, só registrava o erro no console. O estado inicial continuava na
 * tela, e o lojista lia **R$ 0,00** onde a verdade era "não consegui carregar".
 * Numa tela que mostra dinheiro esse é o pior defeito possível — é o mesmo
 * `catch` que devolve valor "seguro" e apaga o diagnóstico.
 *
 * Agora não existe resumo antes da primeira leitura boa: enquanto `leitura` é
 * `null` a tela mostra carregando ou erro, nunca números. Quando já houve
 * leitura boa e a atualização falha, os números **daquela** leitura continuam,
 * com o aviso de que envelheceram — apagá-los trocaria informação verdadeira
 * por nenhuma.
 */
export function useLeituraFinanceira(fetchWithAuth: BuscaAutenticada, ativo: boolean) {
  const [leitura, setLeitura] = useState<LeituraFinanceira | null>(null);
  const [erroDeLeitura, setErroDeLeitura] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  /** Falha ou parcialidade da última sincronização, para a tela não mentir. */
  const [avisoSync, setAvisoSync] = useState('');
  const [filtroTipo, setFiltroTipo] = useState<FiltroDeTipo>('todos');

  const fetchFinanceiro = useCallback(async (isMounted: () => boolean = () => true) => {
    const resultado = await buscarFinanceiro(fetchWithAuth, filtroTipo);
    if (!isMounted()) return;
    if (!resultado.ok) {
      setErroDeLeitura(resultado.erro);
      return;
    }
    setErroDeLeitura(null);
    setLeitura(resultado.leitura);
  }, [filtroTipo, fetchWithAuth]);

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
    if (!ativo) return;
    let isMounted = true;
    void (async () => {
      await fetchFinanceiro(() => isMounted);
    })();
    return () => {
      isMounted = false;
    };
    // `ativo` entra na dependência de propósito: a aba fica montada o tempo
    // todo, então voltar a ela é o único momento em que releitura é pedida —
    // e é aí que uma venda manual registrada no painel precisa aparecer aqui.
  }, [fetchFinanceiro, ativo]);

  const nuncaCarregou = leitura === null;

  return {
    titulos: leitura?.titulos ?? [],
    /** `null` enquanto nenhuma leitura deu certo — nunca zeros de partida. */
    resumo: leitura?.resumo ?? null,
    nuncaCarregou,
    erroDeLeitura,
    /** Ainda não há leitura boa e nada falhou: é isso que carregar significa. */
    carregando: nuncaCarregou && erroDeLeitura === null,
    syncing,
    setSyncing,
    avisoSync,
    filtroTipo,
    setFiltroTipo,
    fetchFinanceiro,
    syncFinanceiro,
    chartData: derivarFluxo(leitura?.titulos ?? []),
  };
}
