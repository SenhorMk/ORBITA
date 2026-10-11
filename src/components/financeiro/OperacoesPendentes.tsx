'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';

import {
  listaDeOperacoesSchema,
  respostaDaQuitacaoSchema,
  respostaDaReconciliacaoSchema,
  situacaoParaOOperador,
  type MotivoDeRevisao,
  type OperacaoFinanceira,
  type Pendencia,
  type SituacaoParaOOperador,
} from '@/lib/config/operacaoFinanceiraContract';

import type { BuscaAutenticada } from './useLeituraFinanceira';

const MOTIVOS: Record<MotivoDeRevisao, string> = {
  sem_referencia: 'lançada antes da referência automática; confira manualmente no Bling',
  consulta_incompleta: 'o Bling não respondeu por completo',
  listagem_incompleta: 'a busca no Bling não terminou',
  nenhum_candidato: 'nenhuma conta com a referência desta operação foi encontrada — isso não prova que ela não exista',
  multiplos_candidatos: 'mais de uma conta corresponde',
  candidato_divergente: 'a conta tem dados diferentes da operação',
  candidatos_demais: 'contas parecidas demais para conferir automaticamente',
  leitura_inconsistente: 'o Bling mudou entre duas leituras',
  conta_ausente: 'a conta não foi encontrada no Bling',
  conta_nao_quitada: 'a conta não aparece quitada no Bling',
  saldo_ausente: 'o Bling não informou o saldo da conta',
  bordero_ausente: 'a conta aparece paga, mas sem borderô',
  borderos_demais: 'borderôs demais para conferir automaticamente',
  quitada_sem_autoria: 'a conta está paga, mas nenhum borderô prova que foi esta quitação — pode ter sido paga por outra pessoa',
  multiplos_borderos: 'mais de um borderô corresponde a esta quitação',
  conta_de_outra_operacao: 'esta conta já pertence a outra operação',
  referencia_de_outra_operacao: 'esta conta tem a referência de outra operação',
  sem_evidencia_positiva: 'a conta não traz a referência desta operação — campos iguais não provam que seja ela. Só vincule se você conferiu no Bling: marque a declaração e confirme de novo',
  titulo_inconsistente: 'o registro local desta operação está inconsistente e precisa de correção administrativa',
};

const SITUACOES: Record<SituacaoParaOOperador, string> = {
  confirmada: 'Confirmada no Bling e registrada no ORBITA.',
  registro_local_pendente: 'Confirmada no Bling, mas o registro no ORBITA ainda não foi concluído — confira de novo.',
  ainda_pendente: 'Ainda pendente — tente conferir de novo em instantes.',
  revisao_manual: 'Revisão manual necessária',
  sem_pendencia: 'Nada pendente nesta operação.',
};

const QUITACOES: Record<string, string> = {
  quitada: 'Quitada no Bling.',
  quitacao_nao_confirmada: 'A quitação foi enviada e não confirmada. Confira no Bling antes de qualquer outra ação.',
  quitacao_recusada: 'O Bling recusou a quitação. A conta continua em aberto.',
  quitacao_nao_enviada: 'A quitação não foi enviada. A conta continua em aberto.',
  ja_quitada_no_bling: 'A conta já estava paga no Bling. Nada foi enviado, e a quitação não foi atribuída ao ORBITA.',
  conta_inconsistente: 'O Bling mostra a conta como paga, mas sem saldo zerado. Nada foi enviado nem marcado como pago.',
  conta_nao_quitavel: 'A conta não está em aberto no Bling. Nada foi enviado.',
  sem_categoria: 'A conta não tem categoria no Bling. Nada foi enviado.',
  consulta_incompleta: 'O Bling não respondeu. Nada foi enviado.',
  nada_pendente: 'Nada pendente nesta operação.',
};

const EFEITOS: Record<Pendencia, string> = {
  conferir_criacao: 'lançamento não confirmado',
  reparo_titulo: 'confirmada no Bling, registro no ORBITA pendente',
  conferir_baixa: 'quitação não confirmada',
  reparo_titulo_pago: 'quitada no Bling, registro no ORBITA pendente',
  quitacao_recusada: 'quitação recusada pelo Bling; a conta continua em aberto',
  pagamento_nao_comprovado: 'o Bling indica pago, sem saldo zerado; o título segue em aberto',
  quitacao_solicitada: 'quitação pedida no lançamento ainda não feita',
  titulo_inconsistente: 'registro local inconsistente — requer correção administrativa',
};

const FALHA = 'Não foi possível concluir agora. Nada foi enviado ao Bling.';

function descricao(operacao: OperacaoFinanceira): string {
  const valor = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(operacao.valor);
  return `${valor}, vencimento ${operacao.dataVencimento} — ${operacao.pendencia ? EFEITOS[operacao.pendencia] : 'sem pendência'}`;
}

/** A criação foi conferida e caiu em revisão manual: só então o operador pode apontar a conta. */
function aceitaConfirmacaoManual(operacao: OperacaoFinanceira): boolean {
  const ultima = operacao.ultimaReconciliacao;
  return operacao.pendencia === 'conferir_criacao' && ultima?.alvo === 'criacao' && ultima.resultado === 'revisao_manual';
}

/**
 * Operações de conta a pagar com algo a resolver (PRE-002).
 *
 * "Conferir no Bling" só LÊ o Bling e conclui o registro local de uma operação
 * já confirmada. Não existe "tentar de novo" — o efeito pode ter acontecido, e
 * lançar outra vez poderia duplicá-lo. "Quitar no Bling" só aparece para a
 * quitação pedida no lançamento e nunca enviada; a revisão manual aceita a
 * conta que o operador conferiu, e o servidor a lê antes de aceitar.
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
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [resultados, setResultados] = useState<Readonly<Record<string, string>>>({});
  const [contas, setContas] = useState<Readonly<Record<string, string>>>({});
  const [declaracoes, setDeclaracoes] = useState<Readonly<Record<string, boolean>>>({});
  const [total, setTotal] = useState(0);
  const [proximoCursor, setProximoCursor] = useState<string | null>(null);
  const [paginas, setPaginas] = useState(1);
  const [falhaDaLista, setFalhaDaLista] = useState(false);

  /** Lê as `quantas` primeiras páginas pelo cursor estável e troca a lista inteira. */
  const carregar = useCallback(async (quantas = 1) => {
    try {
      const lidas: OperacaoFinanceira[] = [];
      let cursor: string | null = null;
      let ultimoTotal = 0;
      for (let pagina = 0; pagina < quantas; pagina++) {
        const url: string = cursor === null ? '/api/financeiro/operacoes' : `/api/financeiro/operacoes?cursor=${encodeURIComponent(cursor)}`;
        const lida = listaDeOperacoesSchema.safeParse(await (await fetchWithAuth(url)).json());
        if (!lida.success) {
          setFalhaDaLista(true);
          return;
        }
        lidas.push(...lida.data.operacoes.filter((o) => !lidas.some((j) => j.ref === o.ref)));
        ultimoTotal = lida.data.total;
        cursor = lida.data.proximoCursor;
        if (cursor === null) break;
      }
      setOperacoes(lidas);
      setTotal(ultimoTotal);
      setProximoCursor(cursor);
      setFalhaDaLista(false);
    } catch {
      // A tela continua, mas diz que a lista pode estar desatualizada.
      setFalhaDaLista(true);
    }
  }, [fetchWithAuth]);

  useEffect(() => {
    if (!ativo) return;
    // Disparada e esquecida: o estado só muda depois da resposta, nunca durante o efeito.
    void (async () => {
      await carregar();
    })();
  }, [ativo, versao, carregar]);

  const executar = async (ref: string, acao: () => Promise<string>) => {
    setOcupado(ref);
    try {
      const mensagem = await acao();
      setResultados((r) => ({ ...r, [ref]: mensagem }));
      // Relê as páginas já abertas: a operação em que se agiu não some de vista.
      await carregar(paginas);
    } catch {
      setResultados((r) => ({ ...r, [ref]: FALHA }));
    } finally {
      setOcupado(null);
    }
  };

  const reconciliar = (ref: string, caminho: 'reconciliar' | 'confirmacao-manual', corpo?: object) => executar(ref, async () => {
    const res = await fetchWithAuth(`/api/financeiro/operacoes/${encodeURIComponent(ref)}/${caminho}`, {
      method: 'POST',
      ...(corpo ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) } : {}),
    });
    const lida = respostaDaReconciliacaoSchema.safeParse(await res.json());
    if (!lida.success) return FALHA;
    const situacao = situacaoParaOOperador(lida.data);
    if (situacao === 'confirmada') onConfirmada();
    if (situacao === 'confirmada' && lida.data.operacao.ultimaReconciliacao?.metodo === 'declaracao_do_operador') {
      return 'Vinculada pela sua declaração, registrada em seu nome — não houve prova automática.';
    }
    const motivo = lida.data.motivo ? `: ${MOTIVOS[lida.data.motivo]}.` : '';
    return situacao === 'revisao_manual' ? SITUACOES[situacao] + motivo : SITUACOES[situacao];
  });

  const quitar = (ref: string) => executar(ref, async () => {
    const res = await fetchWithAuth(`/api/financeiro/operacoes/${encodeURIComponent(ref)}/quitacao`, { method: 'POST' });
    const lida = respostaDaQuitacaoSchema.safeParse(await res.json());
    if (!lida.success) return FALHA;
    if (lida.data.resultado === 'quitada' || lida.data.resultado === 'ja_quitada_no_bling') onConfirmada();
    return QUITACOES[lida.data.resultado] ?? FALHA;
  });

  const soResultados = Object.keys(resultados).filter((ref) => !operacoes.some((o) => o.ref === ref));
  if (operacoes.length === 0 && soResultados.length === 0 && !falhaDaLista) return null;

  return (
    <section
      aria-label="Operações pendentes"
      className="flex flex-col gap-2 px-4 py-3 rounded-xl text-xs flex-none"
      style={{ background: 'var(--chip)', border: '1px solid var(--line)' }}
    >
      <p className="flex items-center gap-2" style={{ color: 'var(--warning)' }}>
        <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden />
        Operações com resultado ainda não concluído. Não lance de novo: confira primeiro.
      </p>
      {falhaDaLista && (
        <output>Não foi possível carregar as pendências agora; a lista pode estar incompleta. Abra a aba de novo para tentar.</output>
      )}
      {proximoCursor !== null && (
        <output>Mostrando {operacoes.length} de {total} pendências.</output>
      )}
      <ul className="flex flex-col gap-2">
        {operacoes.map((operacao) => (
          <li key={operacao.ref} className="flex flex-wrap items-center gap-2">
            <span>{descricao(operacao)}</span>
            {operacao.pendencia === 'titulo_inconsistente' ? null : operacao.pendencia === 'quitacao_solicitada' ? (
              <button
                type="button"
                className="orbita-chip cursor-pointer"
                disabled={ocupado !== null}
                onClick={() => { void quitar(operacao.ref); }}
              >
                {ocupado === operacao.ref ? 'Quitando…' : 'Quitar no Bling'}
              </button>
            ) : (
              <button
                type="button"
                className="orbita-chip cursor-pointer"
                disabled={ocupado !== null}
                onClick={() => { void reconciliar(operacao.ref, 'reconciliar'); }}
              >
                {ocupado === operacao.ref ? 'Conferindo…' : 'Conferir no Bling'}
              </button>
            )}
            {aceitaConfirmacaoManual(operacao) && (
              <span className="flex items-center gap-1">
                <input
                  aria-label="Número da conta no Bling"
                  inputMode="numeric"
                  className="orbita-campo orbita-campo--mono w-28"
                  placeholder="Nº no Bling"
                  value={contas[operacao.ref] ?? ''}
                  onChange={(e) => {
                    const valor = e.target.value.replace(/\D/gu, '');
                    setContas((c) => ({ ...c, [operacao.ref]: valor }));
                  }}
                />
                <label className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={declaracoes[operacao.ref] === true}
                    onChange={(e) => {
                      const marcada = e.target.checked;
                      setDeclaracoes((d) => ({ ...d, [operacao.ref]: marcada }));
                    }}
                  />
                  Declaro que conferi no Bling que esta conta é a desta operação
                </label>
                <button
                  type="button"
                  className="orbita-chip cursor-pointer"
                  disabled={ocupado !== null || !contas[operacao.ref]}
                  onClick={() => {
                    void reconciliar(operacao.ref, 'confirmacao-manual', {
                      blingContaId: contas[operacao.ref], declaracaoDoOperador: declaracoes[operacao.ref] === true,
                    });
                  }}
                >
                  Confirmar esta conta
                </button>
              </span>
            )}
            {resultados[operacao.ref] && <output>{resultados[operacao.ref]}</output>}
          </li>
        ))}
        {soResultados.map((ref) => (
          <li key={ref}><output>{resultados[ref]}</output></li>
        ))}
      </ul>
      {proximoCursor !== null && (
        <button
          type="button"
          className="orbita-chip cursor-pointer self-start"
          disabled={ocupado !== null}
          onClick={() => {
            const quantas = paginas + 1;
            setPaginas(quantas);
            void carregar(quantas);
          }}
        >
          Carregar mais
        </button>
      )}
    </section>
  );
}
