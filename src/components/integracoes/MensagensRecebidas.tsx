'use client';

import { RefreshCw } from 'lucide-react';

import { Pilula } from '@/components/ui/StatusPill';
import type { SelecaoDeOrganizacao } from '@/components/organizacao/usePapelNaOrganizacaoAtiva';
import type { AuthenticatedFetch } from '@/components/organizacao/useOrganizationPanel';
import type { EventoRecebido } from '@/lib/integrations/contratoDaMensageria';
import { useMensagensRecebidas } from './useMensagensRecebidas';

const APARENCIA_DO_ESTADO: Record<EventoRecebido['estado'], { readonly rotulo: string; readonly cor: string }> = {
  recebida: { rotulo: 'Recebida', cor: 'var(--info)' },
  processando: { rotulo: 'Processando', cor: 'var(--info)' },
  processada: { rotulo: 'Processada', cor: 'var(--accent)' },
  ignorada: { rotulo: 'Ignorada', cor: 'var(--txt2)' },
  falha_com_retentativa: { rotulo: 'Falhou, vai repetir', cor: 'var(--warning)' },
  falha_definitiva: { rotulo: 'Falha definitiva', cor: 'var(--danger)' },
};

const EXPLICACAO_DA_DISPOSICAO: Readonly<Record<string, string>> = {
  caso_aberto: 'Caso aberto em triagem.',
  mensagem_no_caso: 'Mensagem somada ao caso aberto da conversa.',
  espelho_atualizado: 'Conversa atualizada; não abre caso.',
  revisao_atrasada: 'Revisão antiga: a mais nova foi mantida.',
  conversa_nao_espelhada: 'Conversa ainda não importada.',
  conexao_nao_comprovada: 'Conversa antiga sem conexão comprovada: não foi alterada.',
  evento_desconhecido: 'Tipo de evento que o ORBITA não trata.',
  conexao_removida: 'A conexão deste evento não existe mais.',
  falha_definitiva: 'Não será repetida sem correção.',
};

/**
 * O caminho de cada mensagem recebida do Chatwoot nesta organização, e os casos
 * abertos (MSG-006). Só leitura: o processamento é do worker, sem botão que o
 * acione daqui. Sem conteúdo da mensagem e sem dado do contato.
 */
export function MensagensRecebidas({
  fetchWithAuth,
  selecao,
}: {
  readonly fetchWithAuth: AuthenticatedFetch;
  readonly selecao: SelecaoDeOrganizacao | null;
}) {
  const leitura = useMensagensRecebidas(fetchWithAuth, selecao);
  const dados = leitura.dados;

  return (
    <section
      aria-label="Mensagens recebidas"
      className="flex flex-col min-w-0"
      style={{ gap: 12, padding: 16, borderRadius: 20, background: 'var(--glass2)', border: '1px solid var(--line)' }}
    >
      <header className="flex items-center justify-between" style={{ gap: 12 }}>
        <h2 className="m-0" style={{ font: '600 13px/1.2 var(--font-archivo), sans-serif', color: 'var(--txt)' }}>
          Mensagens recebidas
        </h2>
        <button type="button" onClick={() => { void leitura.recarregar(); }} className="orbita-chip cursor-pointer" aria-label="Atualizar mensagens">
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </header>
      {leitura.erro !== null ? (
        <p role="alert" className="m-0 text-xs" style={{ color: 'var(--danger)' }}>{leitura.erro}</p>
      ) : dados === null ? (
        <p className="m-0 text-xs" style={{ color: 'var(--txt3)' }}>Lendo as mensagens…</p>
      ) : dados.eventos.length === 0 ? (
        <p className="m-0 text-xs" style={{ color: 'var(--txt3)' }}>Nenhuma mensagem recebida ainda.</p>
      ) : (
        <>
          <p className="m-0 text-xs" style={{ color: 'var(--txt2)' }}>
            {dados.casos.length === 1 ? '1 caso recente.' : `${dados.casos.length} casos recentes.`}
          </p>
          <ul className="m-0 p-0 list-none flex flex-col" style={{ gap: 8 }}>
            {dados.eventos.map((evento) => {
              const aparencia = APARENCIA_DO_ESTADO[evento.estado];
              return (
                <li key={evento.id} className="flex flex-col" style={{ gap: 6, padding: '10px 12px', borderRadius: 14, border: '1px solid var(--line)' }}>
                  <div className="flex items-center justify-between" style={{ gap: 8 }}>
                    <span style={{ font: '400 11px/1.4 var(--font-jetbrains-mono), monospace', color: 'var(--txt2)' }}>
                      {evento.tipo}
                    </span>
                    <Pilula rotulo={aparencia.rotulo} cor={aparencia.cor} />
                  </div>
                  {evento.disposicao !== null && (
                    <p className="m-0 text-xs" style={{ color: 'var(--txt)' }}>
                      {EXPLICACAO_DA_DISPOSICAO[evento.disposicao] ?? evento.disposicao}
                    </p>
                  )}
                  {evento.motivo !== null && (
                    <p className="m-0 text-[11px]" style={{ color: 'var(--txt3)' }}>
                      {evento.motivo}, tentativa {evento.tentativas}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
