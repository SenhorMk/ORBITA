'use client';

import { useCallback, useState } from 'react';
import { Check, Copy, Info } from 'lucide-react';

import { Modal, RodapeDeModal } from '@/components/ui/modal';
import type { ConviteCriado } from './types';
import { HelpInfo } from '@/components/help/HelpInfo';

const ID_DO_FORMULARIO = 'form-criar-convite';

export interface CriarConviteModalProps {
  aberto: boolean;
  onAbertoChange: (aberto: boolean) => void;
  /** Cria o convite no servidor e devolve o código, ou `null` se falhou. */
  onCriar: (email: string, papel: 'admin' | 'member') => Promise<ConviteCriado | null>;
  /** A falha da criação, dita pelo servidor. */
  erro: string | null;
  /** A organização a que este convite pertence — dita ao lado do código. */
  organizacaoNome: string | null;
  /**
   * Avisa quando há um código **na tela**, ainda não dispensado.
   *
   * Quem escuta usa isto para impedir a troca de organização: o código é
   * irrecuperável, e um código de A sob o contexto de B seria uma confusão de
   * tenant.
   */
  onCodigoNaTela: (naTela: boolean) => void;
}

/**
 * O código recém-criado, e a instrução de entrega.
 *
 * O campo é `readOnly` e se seleciona ao ganhar foco: o botão cobre o caminho
 * normal, e a seleção cobre o navegador que nega a área de transferência.
 */
function CodigoEntregavel({
  criado,
  organizacaoNome,
  copiado,
  falhaAoCopiar,
  onCopiar,
}: {
  criado: ConviteCriado;
  organizacaoNome: string | null;
  copiado: boolean;
  falhaAoCopiar: boolean;
  onCopiar: () => void;
}) {
  return (
    <div className="flex flex-col" style={{ gap: 14 }}>
      <div className="flex flex-col" style={{ gap: 6 }}>
        {/*
          O escopo vai no rótulo do próprio código. Ele sobrevive na tela ao fim
          da requisição, e um código sem tenant é um código que a leitura
          seguinte pode fazer parecer de outra organização.
        */}
        <span className="orbita-eyebrow">
          Código do convite{organizacaoNome ? ` · ${organizacaoNome}` : ''}
        </span>
        <div className="flex items-center" style={{ gap: 8 }}>
          <input
            readOnly
            value={criado.token}
            aria-label="Código do convite"
            onFocus={(evento) => evento.currentTarget.select()}
            className="orbita-campo orbita-campo--mono flex-1 min-w-0"
          />
          <button
            type="button"
            onClick={onCopiar}
            className="orbita-acao shrink-0"
            style={{ background: 'var(--accent)', borderColor: 'var(--accent)', color: 'var(--accent-fg)' }}
          >
            {copiado ? <><Check className="w-4 h-4" /> Copiado</> : <><Copy className="w-4 h-4" /> Copiar código</>}
          </button>
        </div>
        {falhaAoCopiar && (
          <p role="alert" className="text-xs" style={{ color: 'var(--warning)' }}>
            O navegador não permitiu copiar automaticamente. Selecione o código acima e copie à mão.
          </p>
        )}
      </div>

      <div
        className="flex items-start px-4 py-3 rounded-xl text-xs"
        style={{ gap: 8, background: 'var(--chip)', border: '1px solid var(--line)', color: 'var(--txt2)' }}
      >
        <Info className="w-4 h-4 shrink-0 mt-px" style={{ color: 'var(--info)' }} aria-hidden />
        <span>
          <strong style={{ color: 'var(--txt)' }}>A entrega é sua.</strong> O Orbita não envia e-mail nenhum:
          mande o código para <strong style={{ color: 'var(--txt)' }}>{criado.email}</strong> por WhatsApp,
          e-mail ou o canal que preferir. Só a conta desse e-mail — <strong style={{ color: 'var(--txt)' }}>com
          o e-mail já confirmado</strong> — consegue aceitá-lo, e ele vale uma única vez. Se o código se
          perder, crie outro convite: este não volta a aparecer, e por isso a troca de organização fica
          suspensa enquanto ele estiver aqui.
        </span>
      </div>
    </div>
  );
}

/**
 * A criação de um convite nominal, e a entrega do código a quem vai entregá-lo.
 *
 * ## O rótulo diz o que acontece
 *
 * "Criar convite", e não "Enviar convite". Nenhuma mensagem é enviada por este
 * sistema: não há serviço de e-mail no caminho, e escrever "enviar" prometeria
 * uma entrega que ninguém faz — a pessoa fecharia a tela achando que o convite
 * está a caminho, e ele nunca chegaria. Depois do sucesso o diálogo troca de
 * assunto: de formulário para código, com a instrução de entrega manual.
 *
 * ## O código vive aqui, e em nenhum outro lugar
 *
 * O token volta uma vez, na resposta da criação. Ele fica neste estado de React
 * enquanto o diálogo está aberto e desaparece quando ele fecha — não vai para
 * `localStorage`, não vai para a URL e não é relido de lista nenhuma. É uma
 * credencial de uso único: quem a guardasse no navegador estaria guardando a
 * chave de entrada da organização. Se o código se perder, o caminho é criar
 * outro convite, e não recuperar este.
 *
 * O e-mail aparece ao lado do código porque um código sem destinatário não diz
 * para quem é — e o convite só será aceito pela conta daquele e-mail.
 */
export function CriarConviteModal({
  aberto,
  onAbertoChange,
  onCriar,
  erro,
  organizacaoNome,
  onCodigoNaTela,
}: CriarConviteModalProps) {
  const [email, setEmail] = useState('');
  const [papel, setPapel] = useState<'admin' | 'member'>('member');
  const [criando, setCriando] = useState(false);
  const [criado, setCriado] = useState<ConviteCriado | null>(null);
  const [copiado, setCopiado] = useState(false);
  const [falhaAoCopiar, setFalhaAoCopiar] = useState(false);

  /**
   * Fechar o diálogo apaga o código — pelo mesmo motivo de ele não ser
   * persistido: nada de credencial sobrevivendo à tela que a pediu.
   *
   * A limpeza mora aqui, e não num efeito, porque **todo** caminho de
   * fechamento passa por este handler: o botão, o X do diálogo, o ESC e o
   * clique fora, que o Radix encaminha para `onAbertoChange`.
   */
  function mudarAberto(proximo: boolean) {
    if (!proximo) {
      setEmail('');
      setPapel('member');
      setCriado(null);
      setCopiado(false);
      setFalhaAoCopiar(false);
      // Dispensar o código é o que libera a troca de organização de novo.
      onCodigoNaTela(false);
    }
    onAbertoChange(proximo);
  }

  async function handleSubmit(evento: React.FormEvent) {
    evento.preventDefault();
    setCriando(true);
    try {
      const resultado = await onCriar(email.trim(), papel);
      if (resultado) {
        setCriado(resultado);
        onCodigoNaTela(true);
      }
    } finally {
      setCriando(false);
    }
  }

  const copiar = useCallback(async () => {
    if (!criado) return;
    setFalhaAoCopiar(false);
    try {
      await navigator.clipboard.writeText(criado.token);
      setCopiado(true);
    } catch {
      // Área de transferência negada pelo navegador ou indisponível. O código
      // continua na tela, selecionável — dizer "copiado" sem ter copiado seria
      // mandar a pessoa colar o que não está lá.
      setFalhaAoCopiar(true);
    }
  }, [criado]);

  return (
    <Modal
      aberto={aberto}
      onAbertoChange={mudarAberto}
      tamanho="md"
      eyebrow={criado ? 'Convite criado' : 'Novo convite'}
      titulo={criado ? 'Entregue o código' : 'Criar convite'}
      descricao={
        criado
          ? 'O convite foi criado. Copie o código e entregue-o à pessoa convidada.'
          : 'Informe o e-mail e o papel da pessoa que você quer convidar.'
      }
      rodape={
        criado ? (
          <RodapeDeModal
            primaria={
              <button type="button" onClick={() => mudarAberto(false)} className="orbita-acao">
                Concluir
              </button>
            }
          />
        ) : (
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
                disabled={criando}
                className="orbita-acao"
                style={{ background: 'var(--accent)', borderColor: 'var(--accent)', color: 'var(--accent-fg)' }}
              >
                {criando ? 'Criando…' : 'Criar convite'}
              </button>
            }
          />
        )
      }
    >
      <HelpInfo ajudaId="org.convidar" />
      {criado ? (
        <CodigoEntregavel
          criado={criado}
          organizacaoNome={organizacaoNome}
          copiado={copiado}
          falhaAoCopiar={falhaAoCopiar}
          onCopiar={() => { void copiar(); }}
        />
      ) : (
        <form id={ID_DO_FORMULARIO} onSubmit={handleSubmit} className="flex flex-col" style={{ gap: 14 }}>
          <div className="flex flex-col" style={{ gap: 6 }}>
            <label htmlFor="convite-email" className="orbita-eyebrow">E-mail do convidado</label>
            <input
              id="convite-email"
              type="email"
              value={email}
              onChange={(evento) => setEmail(evento.target.value)}
              placeholder="pessoa@empresa.com"
              className="orbita-campo"
              required
            />
            <p className="text-xs" style={{ color: 'var(--txt3)' }}>
              O convite é nominal: só a conta autenticada com este e-mail consegue aceitá-lo.
            </p>
          </div>

          <div className="flex flex-col" style={{ gap: 6 }}>
            <label htmlFor="convite-papel" className="orbita-eyebrow">Papel na organização</label>
            <select
              id="convite-papel"
              value={papel}
              onChange={(evento) => setPapel(evento.target.value as 'admin' | 'member')}
              className="orbita-campo cursor-pointer"
            >
              <option value="member">Membro — usa o sistema, não administra</option>
              <option value="admin">Administrador — também convida e remove membros</option>
            </select>
          </div>

          {erro !== null && (
            <p role="alert" className="text-xs" style={{ color: 'var(--danger)' }}>
              {erro}
            </p>
          )}
        </form>
      )}
    </Modal>
  );
}
