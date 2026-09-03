'use client';

import { useReducer, useState } from 'react';
import { AlertCircle, Loader2, Search } from 'lucide-react';

import { fetchWithAuth } from '@/lib/fetchWithAuth';
import { descreverErro } from '@/lib/erroLegivel';

import {
  esquecerTentativaPendente,
  lerTentativasPendentes,
  type TentativaPendente,
} from './tentativaPendente';

/**
 * O caminho de saída, na tela, de uma venda manual que ficou sem desfecho
 * (ticket 30, fatia 3 — 5ª rodada de revisão).
 *
 * Bloquear uma tentativa cujo resultado ninguém confirmou é o comportamento
 * seguro. A revisão apontou o que faltava: sem uma saída, "seguro" vira "esta
 * venda está bloqueada para sempre, limpe o `localStorage`" — e apagar a chave
 * de idempotência é exatamente furar a proteção contra duplicação.
 *
 * Este componente não decide nada sozinho: ele só oferece **conferir**, que
 * chama `POST /api/pedidos/manual/reconciliar`. Quem decide é o Bling,
 * respondendo se o pedido daquela referência existe ou não. A referência só é
 * esquecida aqui quando o servidor devolve `referenciaLiberada: true` — ou
 * seja, quando o desfecho passou a ser CONHECIDO.
 */

interface RespostaDeReconciliacao {
  readonly referenciaLiberada?: boolean;
  readonly mensagem?: string;
  readonly error?: string;
}

async function conferirNoServidor(referencia: string): Promise<RespostaDeReconciliacao> {
  const resposta = await fetchWithAuth('/api/pedidos/manual/reconciliar', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ referenciaLocal: referencia }),
  });
  return (await resposta.json()) as RespostaDeReconciliacao;
}

export function PendenciasDeVendaManual({
  open,
  organizacaoId,
}: {
  readonly open: boolean;
  readonly organizacaoId: string | null;
}) {
  const [conferindo, setConferindo] = useState<string | null>(null);
  const [mensagem, setMensagem] = useState<string | null>(null);
  /** Releitura forçada depois de uma conferência mudar o armazenamento. */
  const [, relerArmazenamento] = useReducer((versao: number) => versao + 1, 0);

  // Lido durante a renderização, de propósito, em vez de copiado para estado
  // dentro de um `useEffect`: sincronizar um armazenamento externo para dentro
  // do estado por efeito é o que a regra `react-hooks/set-state-in-effect`
  // desaconselha, e aqui não há o que sincronizar — a leitura é síncrona,
  // barata (uma lista de no máximo 5) e dá sempre o mesmo resultado para a
  // mesma organização. A única releitura extra vem de uma ação do usuário.
  const pendentes: readonly TentativaPendente[] = organizacaoId && open
    ? lerTentativasPendentes(organizacaoId)
    : [];

  const conferir = async (referencia: string) => {
    if (!organizacaoId) return;
    setConferindo(referencia);
    setMensagem(null);
    try {
      const corpo = await conferirNoServidor(referencia);
      // Só esquece com desfecho conhecido. `referenciaLiberada: false` (o
      // pedido existe no Bling e não existe aqui) mantém a pendência de
      // propósito — ela ainda precisa de uma decisão humana.
      if (corpo.referenciaLiberada) esquecerTentativaPendente(organizacaoId, referencia);
      setMensagem(corpo.mensagem ?? corpo.error ?? 'Não foi possível conferir esta venda agora.');
      relerArmazenamento();
    } catch (erro: unknown) {
      setMensagem(descreverErro(erro));
    } finally {
      setConferindo(null);
    }
  };

  if (pendentes.length === 0 && mensagem === null) return null;

  return (
    <div className="bg-amber-500/10 text-amber-200 p-4 rounded-2xl border border-amber-500/20 mb-6 space-y-3">
      {pendentes.length > 0 && (
        <>
          <div className="flex items-start gap-2 text-sm">
            <AlertCircle className="w-5 h-5 flex-shrink-0" />
            <span className="mt-0.5">
              {pendentes.length === 1
                ? 'Há uma venda anterior cujo resultado não foi confirmado. Confira antes de registrar de novo, para não duplicar o pedido no Bling.'
                : `Há ${pendentes.length} vendas anteriores cujo resultado não foi confirmado. Confira cada uma antes de registrar de novo.`}
            </span>
          </div>
          <ul className="space-y-2">
            {pendentes.map((pendente) => (
              <li key={pendente.referencia} className="flex items-center justify-between gap-3 text-xs">
                <code className="text-amber-100/80 truncate">{pendente.referencia}</code>
                <button
                  type="button"
                  onClick={() => conferir(pendente.referencia)}
                  disabled={conferindo !== null}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-amber-500/20 hover:bg-amber-500/30 disabled:opacity-50 transition-colors flex-shrink-0"
                >
                  {conferindo === pendente.referencia
                    ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    : <Search className="w-3.5 h-3.5" />}
                  Conferir no Bling
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {mensagem && <p className="text-xs text-amber-100/90">{mensagem}</p>}
    </div>
  );
}
