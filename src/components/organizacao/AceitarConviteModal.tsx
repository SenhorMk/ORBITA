'use client';

import { useState } from 'react';
import { Info } from 'lucide-react';

import { Modal, RodapeDeModal } from '@/components/ui/modal';

const ID_DO_FORMULARIO = 'form-aceitar-convite';

/** O mesmo piso do `acceptInviteInputSchema` no servidor. */
const TAMANHO_MINIMO_DO_CODIGO = 16;

export interface AceitarConviteModalProps {
  aberto: boolean;
  onAbertoChange: (aberto: boolean) => void;
  /** Envia o código ao servidor. `true` quando o convite foi aceito. */
  onAceitar: (token: string) => Promise<boolean>;
  /** A falha da aceitação, dita pelo servidor. */
  erro: string | null;
}

/**
 * A entrada do código de um convite recebido.
 *
 * **A identidade não é digitada aqui, e não poderia ser.** O formulário manda
 * só o código: quem está aceitando é a sessão autenticada, e a RPC compara o
 * e-mail do convite com o e-mail do registro de `auth.uid()` (migration 63).
 * Um campo de e-mail nesta tela seria pior que inútil — pareceria que a
 * identidade é escolhida por quem preenche.
 *
 * Por isso a recusa pode acontecer com um código perfeitamente válido: se a
 * conta logada não é a convidada, o convite não é aceito **e não é consumido**.
 * A mensagem do servidor é deliberadamente única para toda recusa (CWE-209),
 * então a tela explica de antemão o que costuma estar errado, em vez de
 * fingir um diagnóstico que não recebeu.
 */
export function AceitarConviteModal({ aberto, onAbertoChange, onAceitar, erro }: AceitarConviteModalProps) {
  const [token, setToken] = useState('');
  const [aceitando, setAceitando] = useState(false);

  /**
   * O código digitado não sobrevive ao fechamento. Fica aqui, e não num efeito,
   * porque todo caminho de fechamento — botão, X, ESC, clique fora — passa por
   * este handler.
   */
  function mudarAberto(proximo: boolean) {
    if (!proximo) setToken('');
    onAbertoChange(proximo);
  }

  async function handleSubmit(evento: React.FormEvent) {
    evento.preventDefault();
    setAceitando(true);
    try {
      const aceitou = await onAceitar(token.trim());
      if (aceitou) mudarAberto(false);
    } finally {
      setAceitando(false);
    }
  }

  return (
    <Modal
      aberto={aberto}
      onAbertoChange={mudarAberto}
      tamanho="md"
      eyebrow="Convite recebido"
      titulo="Aceitar convite"
      descricao="Cole o código que você recebeu de quem administra a organização."
      rodape={
        <RodapeDeModal
          secundaria={
            <button type="button" onClick={() => mudarAberto(false)} className="orbita-chip cursor-pointer">
              Cancelar
            </button>
          }
          primaria={
            <button
              type="submit"
              form={ID_DO_FORMULARIO}
              disabled={aceitando}
              className="orbita-acao"
              style={{ background: 'var(--accent)', borderColor: 'var(--accent)', color: 'var(--accent-fg)' }}
            >
              {aceitando ? 'Aceitando…' : 'Aceitar convite'}
            </button>
          }
        />
      }
    >
      <form id={ID_DO_FORMULARIO} onSubmit={handleSubmit} className="flex flex-col" style={{ gap: 14 }}>
        <div className="flex flex-col" style={{ gap: 6 }}>
          <label htmlFor="convite-token" className="orbita-eyebrow">Código do convite</label>
          <input
            id="convite-token"
            value={token}
            onChange={(evento) => setToken(evento.target.value)}
            className="orbita-campo orbita-campo--mono"
            autoComplete="off"
            spellCheck={false}
            required
            minLength={TAMANHO_MINIMO_DO_CODIGO}
          />
        </div>

        <div
          className="flex items-start px-4 py-3 rounded-xl text-xs"
          style={{ gap: 8, background: 'var(--chip)', border: '1px solid var(--line)', color: 'var(--txt2)' }}
        >
          <Info className="w-4 h-4 shrink-0 mt-px" style={{ color: 'var(--info)' }} aria-hidden />
          <span>
            O convite é nominal: ele só é aceito pela conta cujo e-mail foi convidado, vale uma única vez e
            expira. Se você está com a conta errada, o código continua válido — entre com a conta convidada e
            tente de novo.
          </span>
        </div>

        {erro !== null && (
          <p role="alert" className="text-xs" style={{ color: 'var(--danger)' }}>
            {erro}
          </p>
        )}
      </form>
    </Modal>
  );
}
