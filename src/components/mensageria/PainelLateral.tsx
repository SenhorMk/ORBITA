'use client';

import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';

import type { AuthenticatedFetch } from '@/components/organizacao/useOrganizationPanel';
import { BarraDoAtendimento, type Atendimento } from './BarraDoAtendimento';
import { PainelDaResposta } from './PainelDaResposta';
import { PainelDaTriagem } from './PainelDaTriagem';
import { PainelDoCliente } from './PainelDoCliente';
import type { Mensageria } from './useMensageria';
import estilos from './mensageria.module.css';

export type AbaDoPainel = 'atendimento' | 'triagem' | 'resposta' | 'cliente';

/** Rótulos curtos, para as quatro abas caberem lado a lado no painel. */
export const ROTULO_DA_ABA: Readonly<Record<AbaDoPainel, string>> = {
  atendimento: 'Atendimento',
  triagem: 'Triagem',
  resposta: 'Resposta',
  cliente: 'Cliente',
};

const ABAS = Object.keys(ROTULO_DA_ABA) as AbaDoPainel[];

function Abas({ aba, aoTrocar }: { readonly aba: AbaDoPainel; readonly aoTrocar: (aba: AbaDoPainel) => void }) {
  const lista = useRef<HTMLDivElement | null>(null);
  // Setas e Home/End andam entre as abas, como numa lista de abas de verdade.
  const aoTeclar = (evento: KeyboardEvent<HTMLButtonElement>) => {
    const indice = ABAS.indexOf(aba);
    const alvo = { ArrowRight: indice + 1, ArrowLeft: indice - 1, Home: 0, End: ABAS.length - 1 }[evento.key];
    if (alvo === undefined) return;
    evento.preventDefault();
    const proxima = ABAS[(alvo + ABAS.length) % ABAS.length];
    aoTrocar(proxima);
    lista.current?.querySelector<HTMLButtonElement>(`[data-aba="${proxima}"]`)?.focus();
  };
  return (
    <div ref={lista} role="tablist" aria-label="Ferramentas da conversa" className={estilos.abas}>
      {ABAS.map((opcao) => (
        <button
          key={opcao}
          type="button"
          role="tab"
          id={`aba-${opcao}`}
          data-aba={opcao}
          aria-selected={aba === opcao}
          aria-controls="painel-da-conversa"
          tabIndex={aba === opcao ? 0 : -1}
          onClick={() => aoTrocar(opcao)}
          onKeyDown={aoTeclar}
          className={estilos.aba}
        >
          {ROTULO_DA_ABA[opcao]}
        </button>
      ))}
    </div>
  );
}

/** O conteúdo de cada assunto, reaproveitando os painéis que já existiam. */
function Conteudo({ aba, fetchWithAuth, mensageria, atendimento }: {
  readonly aba: AbaDoPainel;
  readonly fetchWithAuth: AuthenticatedFetch;
  readonly mensageria: Mensageria;
  readonly atendimento: Atendimento;
}) {
  const conversaId = mensageria.selecionada?.id_local ?? null;
  if (conversaId === null) return null;
  switch (aba) {
    case 'atendimento':
      return <BarraDoAtendimento atendimento={atendimento} />;
    case 'triagem':
      return (
        <PainelDaTriagem
          fetchWithAuth={fetchWithAuth}
          conversaId={conversaId}
          semCaso={<p style={{ margin: 0, fontSize: 12, color: 'var(--txt3)' }}>Esta conversa ainda não tem um caso para triar.</p>}
        />
      );
    case 'resposta':
      return (
        <PainelDaResposta
          key={JSON.stringify([conversaId, mensageria.historico.map((m) => [m.id_local, m.updated_at])])}
          fetchWithAuth={fetchWithAuth}
          conversaId={conversaId}
          compositorOcupado={mensageria.rascunho.trim() !== ''}
          usar={mensageria.escreverRascunho}
        />
      );
    case 'cliente':
      return <PainelDoCliente fetchWithAuth={fetchWithAuth} conversaId={conversaId} />;
  }
}

/**
 * As ferramentas da conversa, sob demanda e organizadas por assunto.
 *
 * Na mesa ele fica ao lado da conversa, com rolagem própria: nunca por cima do
 * histórico nem do compositor. No celular ele abre numa folha de baixo, que se
 * fecha com o X, com Escape ou tocando fora.
 */
export function PainelLateral({ aba, aoTrocar, aoFechar, comoFolha, fetchWithAuth, mensageria, atendimento }: {
  readonly aba: AbaDoPainel;
  readonly aoTrocar: (aba: AbaDoPainel) => void;
  readonly aoFechar: () => void;
  readonly comoFolha: boolean;
  readonly fetchWithAuth: AuthenticatedFetch;
  readonly mensageria: Mensageria;
  readonly atendimento: Atendimento;
}) {
  // Escape dentro do painel o fecha. Diálogos abertos por cima (como a ajuda)
  // consomem o Escape antes (preventDefault) e fecham só a si mesmos.
  const lateral = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const elemento = lateral.current;
    if (elemento === null) return undefined;
    const aoTeclar = (evento: globalThis.KeyboardEvent) => {
      if (evento.key === 'Escape' && !evento.defaultPrevented) aoFechar();
    };
    elemento.addEventListener('keydown', aoTeclar);
    return () => elemento.removeEventListener('keydown', aoTeclar);
  }, [aoFechar, comoFolha]);

  const titulo = (nome: ReactNode) => (
    <div className={estilos.painelCabecalho}>
      {nome}
      <button type="button" onClick={aoFechar} className={estilos.botaoIcone} aria-label="Fechar ferramentas">
        <X className="w-4 h-4" aria-hidden />
      </button>
    </div>
  );
  const corpo = (
    <>
      <Abas aba={aba} aoTrocar={aoTrocar} />
      <div id="painel-da-conversa" role="tabpanel" aria-labelledby={`aba-${aba}`} className={estilos.painelCorpo}>
        <Conteudo aba={aba} fetchWithAuth={fetchWithAuth} mensageria={mensageria} atendimento={atendimento} />
      </div>
    </>
  );

  if (comoFolha) {
    return (
      <Dialog.Root open onOpenChange={(aberto) => { if (!aberto) aoFechar(); }}>
        <Dialog.Portal>
          <Dialog.Overlay className={estilos.veu} />
          <Dialog.Content className={estilos.folha} aria-describedby={undefined}
            style={{ backdropFilter: 'blur(var(--blur-modal)) saturate(1.4)', WebkitBackdropFilter: 'blur(var(--blur-modal)) saturate(1.4)' }}>
            <span className={estilos.alca} aria-hidden />
            {titulo(<Dialog.Title className={estilos.painelTitulo}>Ferramentas da conversa</Dialog.Title>)}
            {corpo}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    );
  }

  return (
    <aside ref={lateral} aria-label="Ferramentas da conversa" className={estilos.painel}>
      {titulo(<h2 className={estilos.painelTitulo}>Ferramentas da conversa</h2>)}
      {corpo}
    </aside>
  );
}
