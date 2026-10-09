'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';

import {
  listaDeOperacoesSchema,
  respostaDaReconciliacaoSchema,
  situacaoParaOOperador,
  type MotivoDeRevisao,
  type OperacaoFinanceira,
  type SituacaoParaOOperador,
} from '@/lib/config/operacaoFinanceiraContract';

import type { BuscaAutenticada } from './useLeituraFinanceira';

const MOTIVOS: Record<MotivoDeRevisao, string> = {
  sem_referencia: 'lançada antes da referência automática; confira manualmente no Bling',
  consulta_incompleta: 'o Bling não respondeu por completo',
  listagem_incompleta: 'a busca no Bling não terminou',
  nenhum_candidato: 'nenhuma conta com a referência desta operação foi encontrada — isso não prova que ela não exista',
  multiplos_candidatos: 'mais de uma conta corresponde',
  candidato_divergente: 'uma conta com esta referência tem dados diferentes',
  candidatos_demais: 'contas parecidas demais para conferir automaticamente',
  leitura_inconsistente: 'o Bling mudou entre duas leituras',
  conta_ausente: 'a conta não foi encontrada no Bling',
  conta_nao_quitada: 'a conta não aparece quitada no Bling',
};

const SITUACOES: Record<SituacaoParaOOperador, string> = {
  confirmada: 'Confirmada no Bling.',
  ainda_pendente: 'Ainda pendente — tente conferir de novo em instantes.',
  revisao_manual: 'Revisão manual necessária',
  sem_pendencia: 'Nada pendente nesta operação.',
};

function descricao(operacao: OperacaoFinanceira): string {
  const valor = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(operacao.valor);
  const efeito = operacao.criacao === 'confirmada' ? 'quitação não confirmada' : 'lançamento não confirmado';
  return `${valor}, vencimento ${operacao.dataVencimento} — ${efeito}`;
}

/**
 * Operações de conta a pagar cujo resultado o Bling não confirmou (PRE-002).
 *
 * A única ação é "Conferir no Bling": a reconciliação só LÊ o Bling. Não existe
 * "tentar de novo" — o efeito pode ter acontecido, e lançar outra vez poderia
 * duplicá-lo. Candidatos múltiplos nunca são escolhidos aqui.
 */
export function OperacoesPendentes({
  fetchWithAuth,
  ativo,
  versao,
  onConfirmada,
}: {
  fetchWithAuth: BuscaAutenticada;
  ativo: boolean;
  /** Muda quando algo pode ter criado uma pendência nova (o diálogo de despesa fechou). */
  versao: number;
  /** Uma operação foi confirmada: a leitura do financeiro precisa ser refeita. */
  onConfirmada: () => void;
}) {
  const [operacoes, setOperacoes] = useState<readonly OperacaoFinanceira[]>([]);
  const [conferindo, setConferindo] = useState<string | null>(null);
  const [resultados, setResultados] = useState<Readonly<Record<string, string>>>({});

  const carregar = useCallback(async () => {
    try {
      const res = await fetchWithAuth('/api/financeiro/operacoes');
      const lida = listaDeOperacoesSchema.safeParse(await res.json());
      if (lida.success) setOperacoes(lida.data.operacoes);
    } catch {
      // Lista auxiliar: sem ela a tela continua, e a próxima abertura tenta de novo.
    }
  }, [fetchWithAuth]);

  useEffect(() => {
    if (!ativo) return;
    // Disparada e esquecida: o estado só muda depois da resposta, nunca durante o efeito.
    void (async () => {
      await carregar();
    })();
  }, [ativo, versao, carregar]);

  const conferir = async (ref: string) => {
    setConferindo(ref);
    try {
      const res = await fetchWithAuth(`/api/financeiro/operacoes/${encodeURIComponent(ref)}/reconciliar`, { method: 'POST' });
      const lida = respostaDaReconciliacaoSchema.safeParse(await res.json());
      if (!lida.success) {
        setResultados((r) => ({ ...r, [ref]: 'Não foi possível conferir agora. Nada foi enviado ao Bling.' }));
        return;
      }
      const situacao = situacaoParaOOperador(lida.data);
      const motivo = lida.data.motivo ? `: ${MOTIVOS[lida.data.motivo]}.` : '';
      setResultados((r) => ({ ...r, [ref]: situacao === 'revisao_manual' ? SITUACOES[situacao] + motivo : SITUACOES[situacao] }));
      if (situacao === 'confirmada') onConfirmada();
      await carregar();
    } catch {
      setResultados((r) => ({ ...r, [ref]: 'Não foi possível conferir agora. Nada foi enviado ao Bling.' }));
    } finally {
      setConferindo(null);
    }
  };

  const soResultados = Object.keys(resultados).filter((ref) => !operacoes.some((o) => o.ref === ref));
  if (operacoes.length === 0 && soResultados.length === 0) return null;

  return (
    <section
      aria-label="Operações pendentes"
      className="flex flex-col gap-2 px-4 py-3 rounded-xl text-xs flex-none"
      style={{ background: 'var(--chip)', border: '1px solid var(--line)' }}
    >
      <p className="flex items-center gap-2" style={{ color: 'var(--warning)' }}>
        <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden />
        Operações com resultado não confirmado pelo Bling. Não lance de novo: confira primeiro.
      </p>
      <ul className="flex flex-col gap-2">
        {operacoes.map((operacao) => (
          <li key={operacao.ref} className="flex flex-wrap items-center gap-2">
            <span>{descricao(operacao)}</span>
            <button
              type="button"
              className="orbita-chip cursor-pointer"
              disabled={conferindo !== null}
              onClick={() => { void conferir(operacao.ref); }}
            >
              {conferindo === operacao.ref ? 'Conferindo…' : 'Conferir no Bling'}
            </button>
            {resultados[operacao.ref] && <output>{resultados[operacao.ref]}</output>}
          </li>
        ))}
        {soResultados.map((ref) => (
          <li key={ref}><output>{resultados[ref]}</output></li>
        ))}
      </ul>
    </section>
  );
}
