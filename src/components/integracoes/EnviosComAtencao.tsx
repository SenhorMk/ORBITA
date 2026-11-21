'use client';

import { HelpContext } from '@/components/help/HelpContext';

import { useState } from 'react';
import { RefreshCw, Send } from 'lucide-react';

import { Pilula } from '@/components/ui/StatusPill';
import type { SelecaoDeOrganizacao } from '@/components/organizacao/usePapelNaOrganizacaoAtiva';
import type { AuthenticatedFetch } from '@/components/organizacao/useOrganizationPanel';
import type { EventoDaOutbox } from '@/lib/integrations/contratoDaOutbox';
import { comPrazo } from './comPrazo';
import { useEnviosComAtencao } from './useEnviosComAtencao';

const APARENCIA_DO_DESFECHO: Record<EventoDaOutbox['desfecho'], { readonly rotulo: string; readonly cor: string }> = {
  desconhecido: { rotulo: 'Desconhecido', cor: 'var(--warning)' },
  recusado: { rotulo: 'Recusado', cor: 'var(--danger)' },
  em_andamento: { rotulo: 'Em andamento', cor: 'var(--info)' },
  nao_enviado: { rotulo: 'Não enviado', cor: 'var(--txt2)' },
  confirmado: { rotulo: 'Confirmado', cor: 'var(--accent)' },
};

const ROTULO_DA_TENTATIVA: Record<EventoDaOutbox['tentativas'][number]['desfecho'], string> = {
  em_voo: 'em voo',
  confirmado: 'confirmada',
  recusado: 'recusada',
  nao_enviado: 'não enviada',
  desconhecido: 'desconhecida',
};

function Envio({
  evento,
  podeGerir,
  aoAutorizar,
  ocupado,
}: {
  readonly evento: EventoDaOutbox;
  readonly podeGerir: boolean;
  readonly aoAutorizar: () => void;
  readonly ocupado: boolean;
}) {
  const aparencia = APARENCIA_DO_DESFECHO[evento.desfecho];
  return (
    <li className="flex flex-col" style={{ gap: 6, padding: '10px 12px', borderRadius: 14, border: '1px solid var(--line)' }}>
      <div className="flex items-center justify-between" style={{ gap: 8 }}>
        <span style={{ font: '400 11px/1.4 var(--font-jetbrains-mono), monospace', color: 'var(--txt2)' }}>
          {evento.destino} · {evento.tipo}
        </span>
        <Pilula rotulo={aparencia.rotulo} cor={aparencia.cor} />
      </div>
      <p className="m-0 text-xs" style={{ color: 'var(--txt)' }}>{evento.explicacao}</p>
      {evento.tentativas.length > 0 && (
        <ol className="m-0 p-0 list-none flex flex-wrap" style={{ gap: 6 }} aria-label="Tentativas">
          {evento.tentativas.map((t) => (
            <li key={t.fencingToken} className="text-[11px]" style={{ color: 'var(--txt3)' }}>
              #{t.fencingToken} {ROTULO_DA_TENTATIVA[t.desfecho]}{t.motivo ? ` (${t.motivo})` : ''}
            </li>
          ))}
        </ol>
      )}
      {evento.podeRepetir && podeGerir && (
        <button type="button" onClick={aoAutorizar} disabled={ocupado} className="orbita-chip cursor-pointer self-start" style={{ height: 28, fontSize: 11 }}>
          <Send className="w-3.5 h-3.5" />
          {ocupado ? 'Autorizando…' : 'Autorizar reenvio'}
        </button>
      )}
    </li>
  );
}

/**
 * Envios externos que pedem atenção nesta organização (MSG-007).
 *
 * Um envio desconhecido pode ter chegado ao cliente, e a tela diz isso no
 * lugar de oferecer "tentar de novo": o reenvio só aparece depois que alguém
 * provou que o provedor não aplicou, e o servidor confere de novo.
 */
export function EnviosComAtencao({
  fetchWithAuth,
  selecao,
  podeGerir,
}: {
  readonly fetchWithAuth: AuthenticatedFetch;
  readonly selecao: SelecaoDeOrganizacao | null;
  readonly podeGerir: boolean;
}) {
  const envios = useEnviosComAtencao(fetchWithAuth, selecao);
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [falha, setFalha] = useState<string | null>(null);

  async function autorizar(eventoId: string) {
    setOcupado(eventoId);
    setFalha(null);
    try {
      const resposta = await comPrazo(fetchWithAuth, `/api/integracoes/outbox/${eventoId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ acao: 'replay' }),
      });
      if (!resposta.ok) {
        const corpo = await resposta.json().catch(() => null);
        setFalha(typeof corpo?.error === 'string' ? corpo.error : `O reenvio não foi autorizado (HTTP ${resposta.status}).`);
      }
      await envios.recarregar();
    } catch (causa) {
      setFalha(causa instanceof Error && causa.message ? causa.message : 'Sem resposta do servidor.');
    } finally {
      setOcupado(null);
    }
  }

  return (
    <section
      aria-label="Envios que exigem atenção"
      className="flex flex-col min-w-0"
      style={{ gap: 12, padding: 16, borderRadius: 20, background: 'var(--glass2)', border: '1px solid var(--line)' }}
    >
      <header className="flex items-center justify-between" style={{ gap: 12 }}>
        <HelpContext ajudaId="integracoes.envios">
          <h2 className="m-0" style={{ font: '600 13px/1.2 var(--font-archivo), sans-serif', color: 'var(--txt)' }}>
            Envios que exigem atenção
          </h2>
        </HelpContext>
        <button type="button" onClick={() => { void envios.recarregar(); }} className="orbita-chip cursor-pointer" aria-label="Atualizar envios">
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </header>
      {falha && <p role="alert" className="m-0 text-xs" style={{ color: 'var(--danger)' }}>{falha}</p>}
      {envios.erro !== null ? (
        <p role="alert" className="m-0 text-xs" style={{ color: 'var(--danger)' }}>{envios.erro}</p>
      ) : envios.dados === null ? (
        <p className="m-0 text-xs" style={{ color: 'var(--txt3)' }}>Lendo os envios…</p>
      ) : envios.dados.length === 0 ? (
        <p className="m-0 text-xs" style={{ color: 'var(--txt3)' }}>Nenhum envio desconhecido, recusado ou em andamento.</p>
      ) : (
        <ul className="m-0 p-0 list-none flex flex-col" style={{ gap: 8 }}>
          {envios.dados.map((evento) => (
            <Envio
              key={evento.id}
              evento={evento}
              podeGerir={podeGerir}
              ocupado={ocupado === evento.id}
              aoAutorizar={() => { void autorizar(evento.id); }}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
