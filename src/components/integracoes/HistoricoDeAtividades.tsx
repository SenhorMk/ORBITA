'use client';

import { useCallback, useRef, useState } from 'react';
import { History, RefreshCw } from 'lucide-react';

import { Modal } from '@/components/ui/modal';
import { Pilula } from '@/components/ui/StatusPill';
import { EstadoCarregando, EstadoVazio } from '@/components/ui/estados';
import type { AuthenticatedFetch } from '@/components/organizacao/useOrganizationPanel';
import type { PapelMembro } from '@/lib/organizationContext';
import { rotuloDoMembro } from '@/lib/organizacao/identidadeDoMembro';
import {
  respostaDoHistoricoSchema,
  type Atividade,
  type AutorDaAtividade,
  type OrigemDoHistorico,
} from '@/lib/auditoria/historicoDeAtividades';
import { comPrazo } from './comPrazo';

const POR_PAGINA = 20;

const FILTROS: readonly { readonly rotulo: string; readonly origem: OrigemDoHistorico | null }[] = [
  { rotulo: 'Todos', origem: null },
  { rotulo: 'Pessoas', origem: 'pessoas' },
  { rotulo: 'Bot', origem: 'bot' },
  { rotulo: 'Sistema', origem: 'sistema' },
];

const PAPEL: Record<PapelMembro, { rotulo: string; cor: string }> = {
  owner: { rotulo: 'Dono', cor: 'var(--accent)' },
  admin: { rotulo: 'Administrador', cor: 'var(--info)' },
  member: { rotulo: 'Membro', cor: 'var(--txt2)' },
};

const DATA_HORA = new Intl.DateTimeFormat('pt-BR', {
  dateStyle: 'short', timeStyle: 'medium', timeZone: 'America/Sao_Paulo',
});

function quando(iso: string): string {
  const data = new Date(iso);
  return Number.isNaN(data.getTime()) ? iso : DATA_HORA.format(data);
}

function Autor({ autor, viaAssistente }: { readonly autor: AutorDaAtividade; readonly viaAssistente: boolean }) {
  if (autor.tipo === 'bot') return <Pilula rotulo="Bot (IA)" cor="var(--warning)" />;
  if (autor.tipo === 'sistema') return <Pilula rotulo="Sistema" cor="var(--txt3)" />;
  const papel = autor.papel ? PAPEL[autor.papel] : { rotulo: 'Não é mais membro', cor: 'var(--danger)' };
  return (
    <span className="flex items-center flex-wrap" style={{ gap: 6 }}>
      <strong className="text-sm" style={{ color: 'var(--txt)' }}>{rotuloDoMembro(autor)}</strong>
      <Pilula rotulo={papel.rotulo} cor={papel.cor} />
      {viaAssistente && <Pilula rotulo="via assistente" cor="var(--info)" />}
      {/* O ID completo fica no `title`; o curto basta para distinguir pessoas sem nome. */}
      <span title={autor.userId} style={{ font: '400 11px/1.4 var(--font-jetbrains-mono), monospace', color: 'var(--txt3)' }}>
        ID {autor.userId.slice(0, 8)}
      </span>
    </span>
  );
}

function ItemDoHistorico({ atividade }: { readonly atividade: Atividade }) {
  return (
    <li className="flex flex-col" style={{ gap: 6, padding: '12px 0', borderTop: '1px solid var(--line)' }}>
      <Autor autor={atividade.autor} viaAssistente={atividade.viaAssistente} />
      <span className="text-sm" style={{ color: 'var(--txt2)' }}>{atividade.descricao}</span>
      <span style={{ font: '400 11px/1.4 var(--font-jetbrains-mono), monospace', color: 'var(--txt3)' }}>
        {quando(atividade.createdAt)} · {atividade.acao} · {atividade.recurso}
        {atividade.recursoId ? ` ${atividade.recursoId}` : ''}
        {atividade.correlationId ? ` · req ${atividade.correlationId}` : ''}
      </span>
    </li>
  );
}

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
 * Quem fez o quê, e quando: cada linha diz se foi uma pessoa (nome, papel na
 * organização e ID), a resposta automática da IA ou o sistema. Quem monta a
 * `key` (a seleção de organização) destrói o painel ao trocar de organização,
 * então uma página de A nunca aparece em B.
 */
export function HistoricoDeAtividades({ fetchWithAuth, podeGerir }: HistoricoDeAtividadesProps) {
  const [aberto, setAberto] = useState(false);
  const [origem, setOrigem] = useState<OrigemDoHistorico | null>(null);
  const [atividades, setAtividades] = useState<Atividade[] | null>(null);
  const [total, setTotal] = useState(0);
  const [carregando, setCarregando] = useState(false);
  const [falha, setFalha] = useState<Falha | null>(null);
  // Só a leitura mais recente escreve na tela: trocar de filtro no meio de
  // uma leitura não pode deixar a resposta antiga por cima da nova.
  const leituraAtual = useRef(0);

  const ler = useCallback(async (offset: number, filtro: OrigemDoHistorico | null) => {
    const minha = ++leituraAtual.current;
    setCarregando(true);
    setFalha(null);
    const url = `/api/auditoria?limit=${POR_PAGINA}&offset=${offset}${filtro ? `&origem=${filtro}` : ''}`;
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

  /** Recomeça da primeira página: ao abrir o painel e a cada troca de filtro. */
  function recomecar(filtro: OrigemDoHistorico | null) {
    setOrigem(filtro);
    setAtividades(null);
    void ler(0, filtro);
  }

  const temMais = atividades !== null && atividades.length < total;

  return (
    <>
      <button
        type="button"
        onClick={() => { setAberto(true); recomecar(origem); }}
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
        descricao="Quem fez cada ação nesta organização: pessoa, bot ou sistema, com data e hora."
        descricaoOculta={false}
      >
        <div className="flex flex-col" style={{ gap: 12 }}>
          <fieldset className="orbita-acoes flex-wrap m-0 p-0 border-0 min-w-0">
            <legend className="sr-only">Filtrar por autor</legend>
            {FILTROS.map((f) => (
              <button
                key={f.rotulo}
                type="button"
                className="orbita-chip cursor-pointer"
                aria-pressed={origem === f.origem}
                style={origem === f.origem ? { borderColor: 'var(--accent)', color: 'var(--txt)' } : undefined}
                onClick={() => recomecar(f.origem)}
              >
                {f.rotulo}
              </button>
            ))}
          </fieldset>

          {falha && (
            <div role="alert" className="flex flex-col items-start text-xs" style={{ gap: 8, color: 'var(--danger)' }}>
              <span><strong>{falha.status === 0 ? 'Sem resposta' : `HTTP ${falha.status}`}</strong> — {falha.mensagem}</span>
              <button type="button" className="orbita-acao" onClick={() => { void ler(0, origem); }}>
                <RefreshCw className="w-4 h-4" />
                Tentar de novo
              </button>
            </div>
          )}

          {atividades === null ? (
            !falha && <EstadoCarregando mensagem="Lendo o histórico desta organização…" />
          ) : atividades.length === 0 ? (
            <EstadoVazio titulo="Nada registrado" descricao="Nenhuma atividade com este filtro." />
          ) : (
            <>
              <span className="orbita-eyebrow">{atividades.length} de {total}</span>
              <ul className="m-0 p-0 list-none">
                {atividades.map((a) => <ItemDoHistorico key={a.id} atividade={a} />)}
              </ul>
              {temMais && (
                <button type="button" className="orbita-acao w-fit" disabled={carregando}
                  onClick={() => { void ler(atividades.length, origem); }}>
                  {carregando ? 'Carregando…' : 'Carregar mais'}
                </button>
              )}
            </>
          )}
        </div>
      </Modal>
    </>
  );
}
