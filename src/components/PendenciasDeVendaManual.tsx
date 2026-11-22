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
import { HelpContext } from '@/components/help/HelpContext';

/**
 * O caminho de saída, na tela, de uma venda manual que ficou sem desfecho.
 *
 * Bloquear uma tentativa cujo resultado ninguém confirmou é o comportamento
 * seguro; sem uma saída, a única "solução" seria apagar a chave de
 * idempotência do `localStorage` — o que fura a proteção contra duplicação.
 *
 * Este componente não decide nada sozinho: ele pede ações a
 * `POST /api/pedidos/manual/reconciliar`, e é o servidor quem consulta o Bling
 * e decide o que pode ser concluído (uma consulta sem pedido visível não libera
 * nada). A referência só é esquecida aqui quando o servidor devolve
 * `referenciaLiberada: true` — ou seja, quando o desfecho passou a ser
 * CONHECIDO.
 *
 * ONDE APARECE: dentro de `ManualOrderModal` e na tela de Vendas.
 * DE ONDE VÊM AS PENDÊNCIAS: referências guardadas no navegador por
 * `tentativaPendente.ts`.
 * PRÓXIMO PASSO: `POST /api/pedidos/manual/reconciliar` (`reconciliar/route.ts`).
 */

interface RespostaDeReconciliacao {
  readonly referenciaLiberada?: boolean;
  readonly situacao?: string;
  readonly mensagem?: string;
  readonly error?: string;
}

/**
 * O que se pode pedir sobre uma pendência.
 *
 * `conferir` nunca escreve no ERP (com permissão de gestão, pode registrar no
 * ledger local o que descobriu) e é a ação padrão. As demais são DECISÕES: uma
 * afirma que o pedido nunca existiu (o sistema não deduz isso de uma consulta
 * que não encontrou o pedido), outra cancela no ERP, e a última registra o que
 * a pessoa observou sobre um cancelamento ambíguo. Nenhuma acontece sem ser
 * pedida nomeadamente.
 */
type AcaoDePendencia =
  | 'conferir'
  | 'encerrar-como-nao-criada'
  | 'cancelar-no-bling'
  /**
   * A saída do cancelamento que ficou ambíguo. Não
   * repete o cancelamento: registra o que a pessoa observou no Bling.
   */
  | 'resolver-ambiguidade';

/** O que a pessoa afirma ter visto no ERP ao resolver uma ambiguidade. */
interface DecisaoDaAmbiguidade {
  readonly decisao: 'cancelado' | 'nao-cancelado';
  readonly evidencia: string;
}

async function pedirAoServidor(
  referencia: string,
  acao: AcaoDePendencia,
  decisao?: DecisaoDaAmbiguidade,
): Promise<RespostaDeReconciliacao> {
  const resposta = await fetchWithAuth('/api/pedidos/manual/reconciliar', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ referenciaLocal: referencia, acao, ...decisao }),
  });
  return (await resposta.json()) as RespostaDeReconciliacao;
}

export function PendenciasDeVendaManual({
  open,
  organizacaoId,
  onMudanca,
}: {
  readonly open: boolean;
  readonly organizacaoId: string | null;
  /**
   * Avisa que o armazenamento de pendências mudou.
   *
   * Este bloco também aparece na tela de Vendas, onde o chip "Conflito Bling"
   * conta as mesmas pendências; sem este aviso ele continuaria mostrando uma
   * que já foi resolvida aqui.
   */
  readonly onMudanca?: () => void;
}) {
  const [conferindo, setConferindo] = useState<string | null>(null);
  const [mensagem, setMensagem] = useState<string | null>(null);
  /** Releitura forçada depois de uma conferência mudar o armazenamento. */
  const [, relerArmazenamento] = useReducer((versao: number) => versao + 1, 0);
  /** Última situação relatada por pendência — decide quais decisões oferecer. */
  const [situacaoPorReferencia, setSituacaoPorReferencia] = useState<Record<string, string>>({});
  /** O que a pessoa digitou como evidência do que viu no Bling, por pendência. */
  const [evidenciaPorReferencia, setEvidenciaPorReferencia] = useState<Record<string, string>>({});

  // Lido durante a renderização, de propósito, em vez de copiado para estado
  // dentro de um `useEffect`: sincronizar um armazenamento externo para dentro
  // do estado por efeito é o que a regra `react-hooks/set-state-in-effect`
  // desaconselha, e aqui não há o que sincronizar — a leitura é síncrona,
  // barata (uma lista de no máximo 5) e dá sempre o mesmo resultado para a
  // mesma organização. A única releitura extra vem de uma ação do usuário.
  const pendentes: readonly TentativaPendente[] = organizacaoId && open
    ? lerTentativasPendentes(organizacaoId)
    : [];

  const pedir = async (referencia: string, acao: AcaoDePendencia, decisao?: DecisaoDaAmbiguidade) => {
    if (!organizacaoId) return;
    setConferindo(referencia);
    setMensagem(null);
    try {
      const corpo = await pedirAoServidor(referencia, acao, decisao);
      setSituacaoPorReferencia((anterior) => ({ ...anterior, [referencia]: corpo.situacao ?? '' }));
      // Só esquece com desfecho conhecido. `referenciaLiberada: false` (o
      // pedido existe no Bling e não existe aqui) mantém a pendência de
      // propósito — ela ainda precisa de uma decisão humana.
      if (corpo.referenciaLiberada) esquecerTentativaPendente(organizacaoId, referencia);
      setMensagem(corpo.mensagem ?? corpo.error ?? 'Não foi possível conferir esta venda agora.');
      relerArmazenamento();
      onMudanca?.();
    } catch (erro: unknown) {
      setMensagem(descreverErro(erro));
    } finally {
      setConferindo(null);
    }
  };

  if (pendentes.length === 0 && mensagem === null) return null;

  return (
    <div
      className="p-4 rounded-2xl space-y-3"
      style={{ background: 'var(--chip)', border: '1px solid var(--warning)', color: 'var(--txt)' }}
    >
      <HelpContext ajudaId="vendas.pendencias">
        <span className="orbita-eyebrow">Vendas pendentes</span>
      </HelpContext>
      {pendentes.length > 0 && (
        <>
          <div className="flex items-start gap-2 text-[13px]" style={{ color: 'var(--txt2)' }}>
            <AlertCircle className="w-5 h-5 flex-shrink-0" style={{ color: 'var(--warning)' }} aria-hidden />
            <span className="mt-0.5">
              {pendentes.length === 1
                ? 'Há uma venda anterior cujo resultado não foi confirmado. Confira antes de registrar de novo, para não duplicar o pedido no Bling.'
                : `Há ${pendentes.length} vendas anteriores cujo resultado não foi confirmado. Confira cada uma antes de registrar de novo.`}
            </span>
          </div>
          <ul className="space-y-2">
            {pendentes.map((pendente) => (
              <li key={pendente.referencia} className="text-xs space-y-2">
                <div className="flex items-center justify-between gap-3">
                <code
                  className="truncate text-[11px]"
                  style={{ color: 'var(--txt3)', fontFamily: 'var(--font-jetbrains-mono), monospace' }}
                >
                  {pendente.referencia}
                </code>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <button
                    type="button"
                    onClick={() => pedir(pendente.referencia, 'conferir')}
                    disabled={conferindo !== null}
                    className="orbita-chip cursor-pointer !h-8"
                  >
                    {conferindo === pendente.referencia
                      ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      : <Search className="w-3.5 h-3.5" />}
                    Conferir no Bling
                  </button>

                  {/* A conferência não achou pedido. Isso NÃO prova que ele não
                      existe — o Bling não garante visibilidade imediata —, então
                      encerrar é uma decisão de quem conferiu no ERP. */}
                  {situacaoPorReferencia[pendente.referencia] === 'nenhum_pedido_visivel' && (
                    <button
                      type="button"
                      onClick={() => pedir(pendente.referencia, 'encerrar-como-nao-criada')}
                      disabled={conferindo !== null}
                      className="orbita-chip cursor-pointer !h-8"
                    >
                      Confirmei no Bling: não existe
                    </button>
                  )}

                  {/* O pedido existe lá e a venda não existe aqui. Cancelar
                      ESCREVE no ERP, e por isso é um pedido explícito. */}
                  {situacaoPorReferencia[pendente.referencia] === 'pendente_no_bling' && (
                    <button
                      type="button"
                      onClick={() => pedir(pendente.referencia, 'cancelar-no-bling')}
                      disabled={conferindo !== null}
                      className="orbita-chip cursor-pointer !h-8"
                      style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }}
                    >
                      Cancelar o pedido no Bling
                    </button>
                  )}
                </div>
                </div>

                {/* O CANCELAMENTO FICOU AMBÍGUO. O
                    ORBITA não repete o cancelamento — repetir uma mutação que
                    pode ter acontecido é o que se está evitando. Quem confere
                    no Bling afirma o que viu, e é essa afirmação que destrava
                    a pendência. */}
                {situacaoPorReferencia[pendente.referencia] === 'cancelamento_ambiguo' && (
                  <div className="space-y-2 rounded-xl p-2.5" style={{ background: 'var(--glass2)', border: '1px solid var(--line)' }}>
                    <label className="block text-xs" style={{ color: 'var(--txt2)' }} htmlFor={`evidencia-${pendente.referencia}`}>
                      O que você viu na tela do pedido no Bling?
                    </label>
                    <input
                      id={`evidencia-${pendente.referencia}`}
                      type="text"
                      value={evidenciaPorReferencia[pendente.referencia] ?? ''}
                      onChange={(evento) => setEvidenciaPorReferencia((anterior) => ({
                        ...anterior,
                        [pendente.referencia]: evento.target.value,
                      }))}
                      placeholder="Ex.: o pedido aparece como Cancelado"
                      className="w-full px-2.5 py-1.5 rounded-lg text-xs outline-none"
                      style={{ background: 'var(--chip)', border: '1px solid var(--line)', color: 'var(--txt)' }}
                    />
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        disabled={conferindo !== null || !(evidenciaPorReferencia[pendente.referencia] ?? '').trim()}
                        onClick={() => pedir(pendente.referencia, 'resolver-ambiguidade', {
                          decisao: 'cancelado',
                          evidencia: evidenciaPorReferencia[pendente.referencia] ?? '',
                        })}
                        className="orbita-chip cursor-pointer !h-8"
                      >
                        Está cancelado lá
                      </button>
                      <button
                        type="button"
                        disabled={conferindo !== null || !(evidenciaPorReferencia[pendente.referencia] ?? '').trim()}
                        onClick={() => pedir(pendente.referencia, 'resolver-ambiguidade', {
                          decisao: 'nao-cancelado',
                          evidencia: evidenciaPorReferencia[pendente.referencia] ?? '',
                        })}
                        className="orbita-chip cursor-pointer !h-8"
                      >
                        Continua ativo lá
                      </button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {mensagem && <p className="text-xs" style={{ color: 'var(--txt2)' }}>{mensagem}</p>}
    </div>
  );
}
