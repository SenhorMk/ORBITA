'use client';

import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { UserCheck } from 'lucide-react';

import type { AuthenticatedFetch } from '@/components/organizacao/useOrganizationPanel';
import { Aviso } from './Aviso';
import { useControle, type AcaoDoAtendimento, type ControleVisto } from './useControle';
import type { Mensageria } from './useMensageria';
import { HelpInfo } from '@/components/help/HelpInfo';
import estilos from './mensageria.module.css';

function rotuloDoControle(controle: ControleVisto): string {
  if (controle.modo === 'AI') return controle.automacaoAtiva ? 'Automação responde' : 'Sem atendente';
  if (controle.modo === 'HUMAN_REQUIRED') return 'Aguardando atendente';
  if (controle.souResponsavel) return 'Com você';
  return controle.responsavelId === null ? 'Sem atendente ativo' : 'Com outro atendente';
}

/** A cor do estado: a mesma leitura do rótulo, nunca no lugar dele. */
function corDoControle(controle: ControleVisto): string {
  if (controle.modo === 'AI') return controle.automacaoAtiva ? 'var(--accent-2)' : 'var(--warning)';
  if (controle.modo === 'HUMAN_REQUIRED') return 'var(--warning)';
  if (controle.souResponsavel) return 'var(--accent)';
  return controle.responsavelId === null ? 'var(--warning)' : 'var(--info)';
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
 * Quem responde esta conversa (MSG-009), lido uma vez para a conversa aberta e
 * repartido entre o cabeçalho (estado e assumir) e o painel (devolver e pedir
 * atendente). Assumir pausa a automação e cancela a fila de quem respondia;
 * assumir a conversa de outra pessoa pede confirmação. Devolver exige um
 * resumo, que vai como nota privada, e só aparece quando o servidor diz que a
 * pessoa pode. Os botões só pedem: o servidor confere versão, dono e permissão.
 */
export function useAtendimento(fetchWithAuth: AuthenticatedFetch, mensageria: Mensageria) {
  const conversaId = mensageria.selecionada?.id_local ?? null;
  const controle = useControle(fetchWithAuth, conversaId);
  // O resumo e a confirmação valem para a conversa (e a versão) em que foram pedidos.
  const [resumoGuardado, setResumoGuardado] = useState<{ readonly conversa: string; readonly texto: string } | null>(null);
  const [transferir, setTransferir] = useState<string | null>(null);
  const { recarregar } = controle;

  // Responder uma conversa sem dono a assume no servidor: o estado é relido
  // quando um envio muda de estado.
  const estadosDosEnvios = mensageria.otimistas.map((o) => o.estado).join(',');
  useEffect(() => {
    if (estadosDosEnvios !== '') void recarregar();
  }, [estadosDosEnvios, recarregar]);

  const atual = controle.controle;
  const resumo = resumoGuardado !== null && resumoGuardado.conversa === conversaId ? resumoGuardado.texto : null;
  const chaveDaTransferencia = atual === null ? null : `${conversaId}:${atual.versao}`;
  const confirmando = atual !== null && eDeOutraPessoa(atual) && transferir === chaveDaTransferencia;
  const agir = (acao: AcaoDoAtendimento, nota?: string) => {
    setTransferir(null);
    void controle.agir(acao, nota).then((ok) => {
      if (ok) setResumoGuardado(null);
    });
  };
  const assumir = () => {
    if (atual !== null && eDeOutraPessoa(atual) && !confirmando) {
      setTransferir(chaveDaTransferencia);
      return;
    }
    agir('assumir');
  };
  const escreverResumo = (texto: string | null) => {
    setResumoGuardado(texto === null || conversaId === null ? null : { conversa: conversaId, texto });
  };
  const motivoSemDevolver = atual?.souResponsavel && !atual.podeDevolver && atual.motivoSemDevolver !== null
    ? POR_QUE_NAO_DEVOLVE[atual.motivoSemDevolver] ?? null
    : null;

  return {
    atual,
    carregando: controle.carregando,
    agindo: controle.agindo,
    erro: controle.erro,
    aviso: controle.aviso,
    recarregar,
    /** Assumir aparece para quem ainda não é o responsável humano da conversa. */
    podeAssumir: atual !== null && !(atual.modo === 'HUMAN' && atual.souResponsavel),
    podePedirAtendente: atual?.modo === 'AI',
    podeDevolver: atual?.podeDevolver ?? false,
    confirmando,
    assumir,
    cancelarTransferencia: () => setTransferir(null),
    pedirAtendente: () => agir('exigir_humano'),
    resumo,
    escreverResumo,
    devolver: () => agir('devolver', (resumo ?? '').trim()),
    motivoSemDevolver,
  };
}

export type Atendimento = ReturnType<typeof useAtendimento>;

/** O estado crítico, sempre no cabeçalho: com a automação, aguardando, com você ou com outra pessoa. */
export function EstadoDoAtendimento({ atendimento }: { readonly atendimento: Atendimento }) {
  const { atual } = atendimento;
  const cor = atual === null ? 'var(--txt3)' : corDoControle(atual);
  return (
    <span className={estilos.estadoDoAtendimento}>
      <span className={estilos.estadoChip} style={{ color: cor }}>
        <span className={estilos.ponto} style={{ background: cor }} aria-hidden />
        <output aria-label="Quem atende" className={estilos.estadoTexto}>
          {atual === null ? (atendimento.carregando ? 'Lendo…' : '—') : rotuloDoControle(atual)}
        </output>
      </span>
      <HelpInfo ajudaId="sac.controle" />
    </span>
  );
}

/**
 * Assumir, compacto, no cabeçalho. Assumir a conversa de outro atendente abre a
 * confirmação de transferência, com as mesmas regras de antes.
 */
export function AssumirAtendimento({ atendimento }: { readonly atendimento: Atendimento }) {
  return (
    <>
      {atendimento.podeAssumir && (
        <button type="button" disabled={atendimento.agindo} onClick={atendimento.assumir}
          className={`orbita-acao ${estilos.assumir}`} aria-label="Assumir atendimento" title="Assumir atendimento">
          <UserCheck className="w-4 h-4" aria-hidden />
          <span className={estilos.assumirTexto} aria-hidden>Assumir</span>
        </button>
      )}
      <Dialog.Root open={atendimento.confirmando} onOpenChange={(aberto) => { if (!aberto) atendimento.cancelarTransferencia(); }}>
        <Dialog.Portal>
          <Dialog.Overlay className={estilos.veu} />
          <Dialog.Content role="alertdialog" className={estilos.confirmacao}
            style={{ backdropFilter: 'blur(var(--blur-modal)) saturate(1.4)', WebkitBackdropFilter: 'blur(var(--blur-modal)) saturate(1.4)' }}>
            <Dialog.Title className={estilos.confirmacaoTitulo}>Confirmar transferência</Dialog.Title>
            <Dialog.Description className={estilos.confirmacaoTexto}>
              Esta conversa está com outro atendente. Assumir transfere o atendimento para você e cancela as respostas dele na fila.
            </Dialog.Description>
            <div className={estilos.confirmacaoAcoes}>
              <Dialog.Close asChild>
                <button type="button" className="orbita-chip cursor-pointer">Cancelar</button>
              </Dialog.Close>
              <button type="button" disabled={atendimento.agindo} onClick={atendimento.assumir} className="orbita-acao cursor-pointer">
                Transferir para mim
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}

/** O que precisa ser lido agora, logo abaixo do cabeçalho: só aparece quando existe. */
export function AvisosDoAtendimento({ atendimento }: { readonly atendimento: Atendimento }) {
  const { atual } = atendimento;
  const semNinguem = atual?.modo === 'AI' && !atual.automacaoAtiva;
  if (!semNinguem && atendimento.erro === null && atendimento.aviso === null) return null;
  return (
    <div className={estilos.avisos}>
      {semNinguem && (
        <Aviso tom="atencao">
          A automação ainda não responde conversas: ninguém está atendendo esta. Assuma para responder.
        </Aviso>
      )}
      {atendimento.erro !== null && <Aviso tom="erro">{atendimento.erro}</Aviso>}
      {atendimento.aviso !== null && <Aviso tom="atencao">{atendimento.aviso}</Aviso>}
    </div>
  );
}

/** O painel do atendimento: quem responde, pedir atendente e devolver à automação. */
export function BarraDoAtendimento({ atendimento }: { readonly atendimento: Atendimento }) {
  const { atual, resumo } = atendimento;
  return (
    <section aria-label="Atendimento" className="flex flex-col" style={{ gap: 10 }}>
      <div className="flex items-center flex-wrap" style={{ gap: 8 }}>
        <span className="orbita-eyebrow" style={{ color: 'var(--txt3)' }}>Agora</span>
        <span style={{ fontSize: 12.5, color: 'var(--txt)' }}>
          {atual === null ? (atendimento.carregando ? 'Lendo…' : '—') : rotuloDoControle(atual)}
        </span>
      </div>

      <div className="flex items-center flex-wrap" style={{ gap: 8 }}>
        {atendimento.podePedirAtendente && (
          <button type="button" disabled={atendimento.agindo} onClick={atendimento.pedirAtendente}
            className="orbita-chip cursor-pointer" style={CHIP}>
            Pedir atendente
          </button>
        )}
        {atendimento.podeDevolver && resumo === null && (
          <button type="button" disabled={atendimento.agindo} onClick={() => atendimento.escreverResumo('')}
            className="orbita-chip cursor-pointer" style={CHIP}>
            Devolver à automação
          </button>
        )}
      </div>
      {atendimento.motivoSemDevolver !== null && (
        <span style={{ fontSize: 11, color: 'var(--txt3)' }}>{atendimento.motivoSemDevolver}</span>
      )}

      {resumo !== null && (
        <form
          className="flex flex-col"
          style={{ gap: 8 }}
          onSubmit={(evento) => {
            evento.preventDefault();
            atendimento.devolver();
          }}
        >
          <span style={{ fontSize: 11, color: 'var(--txt3)' }}>
            O resumo vai como nota privada: fica entre os atendentes e não é enviado à cliente.
          </span>
          <textarea
            aria-label="Resumo para a nota privada"
            placeholder="O que foi resolvido e o que falta"
            value={resumo}
            maxLength={2000}
            rows={3}
            onChange={(evento) => atendimento.escreverResumo(evento.target.value)}
            className={`orbita-campo ${estilos.areaDoResumo}`}
          />
          <div className="flex items-center" style={{ gap: 8 }}>
            <button type="submit" disabled={atendimento.agindo || resumo.trim() === ''} className="orbita-acao shrink-0 cursor-pointer">
              Devolver
            </button>
            <button type="button" onClick={() => atendimento.escreverResumo(null)} className="orbita-chip cursor-pointer shrink-0" style={CHIP}>
              Cancelar
            </button>
          </div>
        </form>
      )}

      <p style={{ margin: 0, fontSize: 11, color: 'var(--txt3)' }}>
        Assuma, responda e devolva a conversa pelo ORBITA. Mudanças feitas no Chatwoot chegam por eventos e podem levar tempo.
      </p>
    </section>
  );
}
