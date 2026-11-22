'use client';

import { useLayoutEffect, useRef } from 'react';
import { Send } from 'lucide-react';

import { HelpInfo } from '@/components/help/HelpInfo';
import { Aviso } from './Aviso';
import type { Mensageria } from './useMensageria';
import estilos from './mensageria.module.css';

/** A altura máxima do campo antes de ele passar a rolar por dentro (~6 linhas). */
const ALTURA_MAXIMA_PX = 168;

/**
 * O compositor, sempre no pé da conversa, e o bloqueio honesto quando o
 * provedor se disse indisponível.
 *
 * Enter envia e Shift+Enter quebra a linha; durante a composição de acentos
 * (IME) o Enter é do teclado, não do envio. O rascunho é o da conversa, guardado
 * no hook: abrir e fechar menus ou o painel não o toca. As garantias de envio
 * (commandId, repetição segura, recuperação) continuam todas em `useEnvio`.
 */
export function Compositor({ mensageria }: { readonly mensageria: Mensageria }) {
  const campo = useRef<HTMLTextAreaElement | null>(null);
  const bloqueado = mensageria.integracaoIndisponivel !== null;
  const podeEnviar = !mensageria.enviando && mensageria.rascunho.trim() !== '' && !bloqueado;

  // O campo cresce com o texto até ~6 linhas.
  useLayoutEffect(() => {
    const elemento = campo.current;
    if (elemento === null) return;
    elemento.style.height = 'auto';
    elemento.style.height = `${Math.min(elemento.scrollHeight, ALTURA_MAXIMA_PX)}px`;
  }, [mensageria.rascunho]);

  return (
    <form
      className={estilos.compositor}
      onSubmit={(evento) => {
        evento.preventDefault();
        if (podeEnviar) mensageria.enviar();
      }}
    >
      {bloqueado && (
        <Aviso tom="atencao">
          Integração Chatwoot indisponível para esta organização — {mensageria.integracaoIndisponivel}. O histórico
          espelhado continua legível; o envio volta quando a conexão estiver configurada.
        </Aviso>
      )}

      <div className={estilos.caixa}>
        <textarea
          ref={campo}
          rows={1}
          aria-label="Mensagem"
          aria-describedby="dica-do-compositor"
          placeholder={bloqueado ? 'Envio indisponível nesta organização' : 'Escreva sua resposta'}
          value={mensageria.rascunho}
          onChange={(evento) => mensageria.escreverRascunho(evento.target.value)}
          onKeyDown={(evento) => {
            if (evento.key !== 'Enter' || evento.shiftKey || evento.nativeEvent.isComposing) return;
            evento.preventDefault();
            if (podeEnviar) mensageria.enviar();
          }}
          disabled={bloqueado}
          className={estilos.campo}
        />
        <HelpInfo ajudaId="sac.envio" />
        <button type="submit" disabled={!podeEnviar} className={`orbita-acao ${estilos.enviar}`}>
          <Send className="w-4 h-4" aria-hidden />
          <span className={estilos.enviarTexto}>{mensageria.enviando ? 'Enviando…' : 'Enviar'}</span>
        </button>
      </div>
      <p id="dica-do-compositor" className={estilos.dica}>
        Enter envia · Shift+Enter quebra a linha. A mensagem entra na fila e só aparece como enviada com o recibo do Chatwoot.
      </p>
    </form>
  );
}
