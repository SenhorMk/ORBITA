'use client';

import { useEffect, useState } from 'react';

import type { AuthenticatedFetch } from '@/components/organizacao/useOrganizationPanel';
import { Aviso } from './Aviso';
import { useControle, type AcaoDoAtendimento, type ControleVisto } from './useControle';
import type { Mensageria } from './useMensageria';
import { HelpInfo } from '@/components/help/HelpInfo';

function rotuloDoControle(controle: ControleVisto): string {
  if (controle.modo === 'AI') return controle.automacaoAtiva ? 'Automação responde' : 'Sem atendente';
  if (controle.modo === 'HUMAN_REQUIRED') return 'Aguardando atendente';
  if (controle.souResponsavel) return 'Com você';
  return controle.responsavelId === null ? 'Sem atendente ativo' : 'Com outro atendente';
}

/** Conversa de outra pessoa da organização: assumir é transferir. */
function eDeOutraPessoa(controle: ControleVisto): boolean {
  return controle.modo === 'HUMAN' && !controle.souResponsavel && controle.responsavelId !== null;
}

const POR_QUE_NAO_DEVOLVE: Partial<Record<NonNullable<ControleVisto['motivoSemDevolver']>, string>> = {
  sem_capacidade: 'Só quem gerencia a organização devolve à automação.',
  automacao_inativa: 'Devolver à automação fica disponível quando a automação estiver ativa.',
};

const CHIP = { height: 28, fontSize: 11 } as const;

/**
 * Quem responde esta conversa (MSG-009). Assumir pausa a automação e cancela a
 * fila de quem respondia; assumir a conversa de outra pessoa pede confirmação.
 * Devolver exige um resumo, que vai como nota privada, e só aparece quando o
 * servidor diz que a pessoa pode. Os botões só pedem: o servidor confere
 * versão, dono e permissão.
 */
export function BarraDoAtendimento({
  fetchWithAuth,
  mensageria,
}: {
  readonly fetchWithAuth: AuthenticatedFetch;
  readonly mensageria: Mensageria;
}) {
  const conversaId = mensageria.selecionada?.id_local ?? null;
  const controle = useControle(fetchWithAuth, conversaId);
  const [resumo, setResumo] = useState<string | null>(null);
  // A confirmação vale para a conversa e a versão em que foi pedida.
  const [transferir, setTransferir] = useState<string | null>(null);
  const { recarregar } = controle;

  // Responder uma conversa sem dono a assume no servidor: o estado é relido
  // quando um envio muda de estado.
  const estadosDosEnvios = mensageria.otimistas.map((o) => o.estado).join(',');
  useEffect(() => {
    if (estadosDosEnvios !== '') void recarregar();
  }, [estadosDosEnvios, recarregar]);

  const atual = controle.controle;
  const chaveDaTransferencia = atual === null ? null : `${conversaId}:${atual.versao}`;
  const confirmando = atual !== null && eDeOutraPessoa(atual) && transferir === chaveDaTransferencia;
  const agir = (acao: AcaoDoAtendimento, nota?: string) => {
    setTransferir(null);
    void controle.agir(acao, nota).then((ok) => {
      if (ok) setResumo(null);
    });
  };
  const assumir = () => {
    if (atual !== null && eDeOutraPessoa(atual) && !confirmando) {
      setTransferir(chaveDaTransferencia);
      return;
    }
    agir('assumir');
  };
  const motivoSemDevolver = atual?.souResponsavel && !atual.podeDevolver && atual.motivoSemDevolver !== null
    ? POR_QUE_NAO_DEVOLVE[atual.motivoSemDevolver] ?? null
    : null;

  return (
    <div className="flex flex-col flex-none" style={{ gap: 8, padding: '10px 14px', borderTop: '1px solid var(--line)' }}>
      <HelpInfo ajudaId="sac.controle" />
      <div className="flex items-center flex-wrap" style={{ gap: 8 }}>
        <span className="orbita-eyebrow" style={{ color: 'var(--txt3)' }}>Atendimento</span>
        <output aria-label="Quem atende" style={{ fontSize: 12, color: 'var(--txt)' }}>
          {atual === null ? (controle.carregando ? 'Lendo…' : '—') : rotuloDoControle(atual)}
        </output>
        {atual !== null && !(atual.modo === 'HUMAN' && atual.souResponsavel) && !confirmando && (
          <button type="button" disabled={controle.agindo} onClick={assumir}
            className="orbita-chip cursor-pointer" style={CHIP}>
            Assumir atendimento
          </button>
        )}
        {atual?.modo === 'AI' && (
          <button type="button" disabled={controle.agindo} onClick={() => agir('exigir_humano')}
            className="orbita-chip cursor-pointer" style={CHIP}>
            Pedir atendente
          </button>
        )}
        {atual?.podeDevolver && resumo === null && (
          <button type="button" disabled={controle.agindo} onClick={() => setResumo('')}
            className="orbita-chip cursor-pointer" style={CHIP}>
            Devolver à automação
          </button>
        )}
        {motivoSemDevolver !== null && (
          <span style={{ fontSize: 11, color: 'var(--txt3)' }}>{motivoSemDevolver}</span>
        )}
      </div>

      <p style={{ margin: 0, fontSize: 11, color: 'var(--txt3)' }}>
        Assuma, responda e devolva a conversa pelo ORBITA. Mudanças feitas no Chatwoot chegam por eventos e podem levar tempo.
      </p>

      {atual?.modo === 'AI' && !atual.automacaoAtiva && (
        <Aviso tom="atencao">
          A automação ainda não responde conversas: ninguém está atendendo esta. Assuma para responder.
        </Aviso>
      )}

      {confirmando && (
        <fieldset aria-label="Confirmar transferência" className="flex items-center flex-wrap"
          style={{ gap: 8, border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          <span style={{ fontSize: 12, color: 'var(--txt)' }}>
            Esta conversa está com outro atendente. Assumir transfere o atendimento para você e cancela as respostas dele na fila.
          </span>
          <button type="button" disabled={controle.agindo} onClick={assumir} className="orbita-acao shrink-0 cursor-pointer">
            Transferir para mim
          </button>
          <button type="button" onClick={() => setTransferir(null)} className="orbita-chip cursor-pointer shrink-0" style={CHIP}>
            Cancelar
          </button>
        </fieldset>
      )}

      {resumo !== null && (
        <form
          className="flex items-center"
          style={{ gap: 8 }}
          onSubmit={(evento) => {
            evento.preventDefault();
            agir('devolver', resumo.trim());
          }}
        >
          <input
            type="text"
            aria-label="Resumo para a nota privada"
            placeholder="Resumo do atendimento (vai como nota privada)"
            value={resumo}
            maxLength={2000}
            onChange={(evento) => setResumo(evento.target.value)}
            className="orbita-campo flex-1 min-w-0"
          />
          <button type="submit" disabled={controle.agindo || resumo.trim() === ''} className="orbita-acao shrink-0 cursor-pointer">
            Devolver
          </button>
          <button type="button" onClick={() => setResumo(null)} className="orbita-chip cursor-pointer shrink-0" style={CHIP}>
            Cancelar
          </button>
        </form>
      )}

      {controle.erro !== null && <Aviso tom="erro">{controle.erro}</Aviso>}
      {controle.aviso !== null && <Aviso tom="atencao">{controle.aviso}</Aviso>}
    </div>
  );
}
