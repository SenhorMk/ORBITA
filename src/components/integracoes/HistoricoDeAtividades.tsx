'use client';

import { useCallback, useRef, useState } from 'react';
import { History, RefreshCw } from 'lucide-react';

import { Modal } from '@/components/ui/modal';
import { AbasDeVisao } from '@/components/ui/AbasDeVisao';
import { EstadoCarregando, EstadoVazio } from '@/components/ui/estados';
import type { AuthenticatedFetch } from '@/components/organizacao/useOrganizationPanel';
import { respostaDoHistoricoSchema, type Atividade, type OrigemDoHistorico } from '@/lib/auditoria/historicoDeAtividades';
import { agruparPorDia } from '@/lib/auditoria/apresentacaoDoHistorico';
import { comPrazo } from './comPrazo';
import { LinhaDoHistorico } from './LinhaDoHistorico';

const POR_PAGINA = 20;

type Filtro = 'todos' | OrigemDoHistorico;

const FILTROS: readonly { readonly id: Filtro; readonly rotulo: string; readonly vazio: string }[] = [
  { id: 'todos', rotulo: 'Todos', vazio: 'Ainda não há atividades registradas nesta organização.' },
  { id: 'pessoas', rotulo: 'Pessoas', vazio: 'Nenhuma ação feita por pessoas da organização.' },
  { id: 'bot', rotulo: 'Bot', vazio: 'O bot de atendimento ainda não respondeu ninguém.' },
  { id: 'sistema', rotulo: 'Sistema', vazio: 'Nenhuma ação automática do sistema.' },
];

interface Falha { readonly status: number; readonly mensagem: string }

async function lerFalha(resposta: Response): Promise<Falha> {
  const corpo: unknown = await resposta.json().catch(() => null);
  const erro = typeof corpo === 'object' && corpo !== null ? (corpo as { error?: unknown }).error : undefined;
  return { status: resposta.status, mensagem: typeof erro === 'string' ? erro : 'A leitura do histórico falhou.' };
}

export interface HistoricoDeAtividadesProps {
  readonly fetchWithAuth: AuthenticatedFetch;
  /** Aparência: o servidor exige `organization:manage` de novo. */
  readonly podeGerir: boolean;
}

/**
 * Botão e painel do histórico de atividades da organização ativa.
 *
 * Quem fez o quê, e quando, agrupado por dia: cada linha diz se foi uma pessoa
 * (nome e papel na organização), o bot de atendimento ou o sistema. Quem monta
 * a `key` (a seleção de organização) destrói o painel ao trocar de organização,
 * então uma página de A nunca aparece em B.
 */
export function HistoricoDeAtividades({ fetchWithAuth, podeGerir }: HistoricoDeAtividadesProps) {
  const [aberto, setAberto] = useState(false);
  const [filtro, setFiltro] = useState<Filtro>('todos');
  const [atividades, setAtividades] = useState<Atividade[] | null>(null);
  const [total, setTotal] = useState(0);
  const [carregando, setCarregando] = useState(false);
  const [falha, setFalha] = useState<Falha | null>(null);
  // Só a leitura mais recente escreve na tela: trocar de filtro no meio de
  // uma leitura não pode deixar a resposta antiga por cima da nova.
  const leituraAtual = useRef(0);

  const ler = useCallback(async (offset: number, escolhido: Filtro) => {
    const minha = ++leituraAtual.current;
    setCarregando(true);
    setFalha(null);
    const url = `/api/auditoria?limit=${POR_PAGINA}&offset=${offset}${escolhido === 'todos' ? '' : `&origem=${escolhido}`}`;
    try {
      const resposta = await comPrazo(fetchWithAuth, url);
      if (minha !== leituraAtual.current) return;
      if (!resposta.ok) {
        setFalha(await lerFalha(resposta));
        return;
      }
      const corpo = respostaDoHistoricoSchema.safeParse(await resposta.json());
      if (!corpo.success) {
        setFalha({ status: resposta.status, mensagem: 'O servidor respondeu em um formato inesperado.' });
        return;
      }
      setAtividades((anteriores) => (offset === 0 ? corpo.data.atividades : [...(anteriores ?? []), ...corpo.data.atividades]));
      setTotal(corpo.data.total);
    } catch (causa) {
      if (minha === leituraAtual.current) {
        setFalha({ status: 0, mensagem: causa instanceof Error ? causa.message : 'Falha de rede ao ler o histórico.' });
      }
    } finally {
      if (minha === leituraAtual.current) setCarregando(false);
    }
  }, [fetchWithAuth]);

  /** Recomeça da primeira página: ao abrir, ao atualizar e a cada troca de filtro. */
  function recomecar(escolhido: Filtro) {
    setFiltro(escolhido);
    setAtividades(null);
    void ler(0, escolhido);
  }

  const temMais = atividades !== null && atividades.length < total;
  const vazio = FILTROS.find((f) => f.id === filtro)?.vazio ?? '';

  return (
    <>
      <button
        type="button"
        onClick={() => { setAberto(true); recomecar(filtro); }}
        className="orbita-chip cursor-pointer"
        disabled={!podeGerir}
        title={podeGerir ? undefined : 'Só administradores e donos veem o histórico.'}
      >
        <History className="w-4 h-4" />
        Histórico de atividades
      </button>

      <Modal
        aberto={aberto}
        onAbertoChange={setAberto}
        tamanho="drawer"
        eyebrow="Rastreabilidade"
        titulo="Histórico de atividades"
        descricao="Tudo o que foi feito nesta organização, por quem e quando: pessoas, o bot de atendimento e o sistema."
        descricaoOculta={false}
      >
        <div className="flex flex-col" style={{ gap: 14 }}>
          <AbasDeVisao rotulo="Quem fez" abas={FILTROS} ativa={filtro} onMudar={recomecar} />

          {falha && (
            <div role="alert" className="flex flex-col items-start text-xs"
              style={{ gap: 8, padding: 12, borderRadius: 14, border: '1px solid var(--danger)', color: 'var(--txt2)' }}>
              <span><strong style={{ color: 'var(--danger)' }}>{falha.status === 0 ? 'Sem resposta' : `HTTP ${falha.status}`}</strong> — {falha.mensagem}</span>
              <button type="button" className="orbita-acao" onClick={() => recomecar(filtro)}>
                <RefreshCw className="w-4 h-4" />
                Tentar de novo
              </button>
            </div>
          )}

          {atividades === null ? (
            !falha && <EstadoCarregando mensagem="Lendo o histórico desta organização…" />
          ) : atividades.length === 0 ? (
            <EstadoVazio titulo="Nada por aqui" descricao={vazio} />
          ) : (
            <>
              <div className="flex items-center justify-between" style={{ gap: 8 }}>
                <span className="text-xs" style={{ color: 'var(--txt3)' }}>
                  Mostrando {atividades.length} de {total} {total === 1 ? 'registro' : 'registros'}
                </span>
                <button type="button" className="orbita-chip cursor-pointer" disabled={carregando} onClick={() => recomecar(filtro)}>
                  <RefreshCw className="w-3.5 h-3.5" />
                  Atualizar
                </button>
              </div>

              {agruparPorDia(atividades, new Date()).map((grupo) => (
                <section key={grupo.rotulo} className="flex flex-col">
                  <h3 className="orbita-eyebrow m-0" style={{ padding: '0 4px 6px' }}>{grupo.rotulo}</h3>
                  <ul className="m-0 p-0 list-none">
                    {grupo.atividades.map((a) => <LinhaDoHistorico key={a.id} atividade={a} />)}
                  </ul>
                </section>
              ))}

              {temMais && (
                <button type="button" className="orbita-acao w-fit self-center" disabled={carregando}
                  onClick={() => { void ler(atividades.length, filtro); }}>
                  {carregando ? 'Carregando…' : `Carregar mais ${Math.min(POR_PAGINA, total - atividades.length)}`}
                </button>
              )}
            </>
          )}
        </div>
      </Modal>
    </>
  );
}
