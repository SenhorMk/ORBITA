'use client';

import { useState } from "react";
import { CheckCircle2, Copy, Loader2, MessageCircle, Pencil, Trash2 } from 'lucide-react';
import { Modal, RodapeDeModal } from '@/components/ui/modal';
import { Pilula } from '@/components/ui/StatusPill';
import { mensagemDaCorrecao, type DesfechoDaCorrecao } from '@/lib/config/correcaoOperacionalContract';
import type { Cliente } from '@/types';

/**
 * O detalhe de um cliente, no `Modal` do Design System.
 *
 * Exibe os campos do contrato de cliente (endereço e CEP inclusive, persistidos
 * pela migration 54), copia telefone, e-mail e documento para a área de
 * transferência e abre a conversa no Chatwoot.
 *
 * A ação primária é **editar**, no canto inferior direito; excluir fica sozinha
 * à esquerda, longe dela, e pede confirmação.
 *
 * ## O que a tela de Clientes de fato oferece hoje
 *
 * - **criar** um contato: pelo botão da tela;
 * - **editar** um contato existente: pela ação primária daqui, que preenche
 *   `selectedClienteToEdit` em `page.tsx` (coberto por
 *   `clientes/ligacao-detalhe-edicao.test.tsx`);
 * - **excluir** um contato: pela ação destrutiva, sozinha à esquerda do rodapé.
 *   Ela não exclui direto: troca o corpo do mesmo modal pela confirmação — o
 *   Design System não empilha diálogo dentro de diálogo. Só depois de o
 *   servidor responder `Deleted` a tela é avisada (`onExcluido`) e relê a
 *   lista; até lá o detalhe continua aberto e o contato continua na lista.
 *
 * Quem decide se o contato pode sair é o servidor (`POST /api/clientes/delete`):
 * com histórico ele responde `Blocked`, e esta tela só mostra a frase do
 * contrato (`mensagemDaCorrecao`), nunca texto do banco ou do Bling.
 *
 * Produto não é excluído: a tela de produto arquiva (`POST /api/produtos/arquivar`,
 * PRE-003), e o histórico de pedidos fica.
 */

interface ClienteDetailModalProps {
  isOpen: boolean;
  onClose: () => void;
  cliente: Cliente | null;
  onOpenChatwoot?: (phone?: string, name?: string) => void;
  onEdit?: (cliente: Cliente) => void;
  /**
   * Pede ao servidor a exclusão. Recebe só o id local — o `bling_id` usado lá
   * é o do banco. Sem esta prop a ação destrutiva não aparece.
   */
  onExcluir?: (clienteId: string) => Promise<DesfechoDaCorrecao>;
  /** O servidor confirmou que o contato não existe mais: feche e releia. */
  onExcluido?: () => void;
}

function Campo({
  rotulo,
  valor,
  mono,
  aoCopiar,
  copiado,
}: {
  rotulo: string;
  valor?: string;
  mono?: boolean;
  aoCopiar?: () => void;
  copiado?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-xs shrink-0" style={{ color: 'var(--txt3)' }}>{rotulo}</span>
      <span className="flex items-center gap-2 min-w-0">
        <span
          className="text-[13px] text-right truncate"
          style={{
            color: 'var(--txt)',
            fontFamily: mono ? 'var(--font-jetbrains-mono), monospace' : undefined,
          }}
          title={valor}
        >
          {valor || '—'}
        </span>
        {valor && aoCopiar && (
          <button
            type="button"
            onClick={aoCopiar}
            aria-label={`Copiar ${rotulo.toLowerCase()}`}
            className="shrink-0 cursor-pointer"
            style={{ color: copiado ? 'var(--accent)' : 'var(--txt3)' }}
          >
            {copiado ? <CheckCircle2 className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
          </button>
        )}
      </span>
    </div>
  );
}

function Secao({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h4 className="orbita-eyebrow">{titulo}</h4>
      <div className="flex flex-col gap-2.5">{children}</div>
    </section>
  );
}

export function ClienteDetailModal({
  isOpen,
  onClose,
  cliente,
  onOpenChatwoot,
  onEdit,
  onExcluir,
  onExcluido,
}: ClienteDetailModalProps) {
  const [campoCopiado, setCampoCopiado] = useState<string | null>(null);
  /** O contato em confirmação de exclusão — `null` é o detalhe normal. */
  const [confirmandoId, setConfirmandoId] = useState<string | null>(null);
  const [excluindo, setExcluindo] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);

  // A confirmação pertence a UM contato: abrir outro volta ao detalhe.
  const confirmando = cliente !== null && confirmandoId !== null && confirmandoId === cliente.id;

  const fechar = () => {
    if (excluindo) return;
    setConfirmandoId(null);
    setAviso(null);
    onClose();
  };

  const confirmarExclusao = async () => {
    if (!cliente?.id || !onExcluir || excluindo) return;
    setExcluindo(true);
    setAviso(null);
    const desfecho = await onExcluir(cliente.id);
    setExcluindo(false);
    // `NotFound` também encerra: o contato não existe mais aqui, e a lista
    // precisa ser relida para parar de mostrá-lo.
    if (desfecho.resultado === 'Deleted' || desfecho.resultado === 'NotFound') {
      setConfirmandoId(null);
      onExcluido?.();
      return;
    }
    setAviso(mensagemDaCorrecao(desfecho));
  };

  const copiar = (texto: string, campo: string) => {
    if (!texto) return;
    navigator.clipboard.writeText(texto);
    setCampoCopiado(campo);
    setTimeout(() => setCampoCopiado(null), 2000);
  };

  if (!cliente) return null;

  const endereco = [cliente.endereco, cliente.numero, cliente.bairro, cliente.cidade, cliente.uf]
    .filter(Boolean)
    .join(', ');

  return (
    <Modal
      aberto={isOpen}
      onAbertoChange={(aberto) => {
        if (!aberto) fechar();
      }}
      tamanho={confirmando ? 'sm' : 'lg'}
      destrutivo={confirmando}
      dispensavel={!excluindo}
      eyebrow={confirmando ? 'Ação irreversível' : 'Contato'}
      titulo={confirmando ? 'Excluir este contato?' : cliente.nome}
      descricao={confirmando ? 'Confirmação de exclusão de contato.' : 'Detalhes do contato, como estão no Orbita e no Bling.'}
      rodape={confirmando ? (
        <RodapeDeModal
          secundaria={
            <button
              type="button"
              onClick={() => { setConfirmandoId(null); setAviso(null); }}
              disabled={excluindo}
              className="orbita-chip cursor-pointer"
            >
              Voltar
            </button>
          }
          primaria={
            <button
              type="button"
              onClick={() => { void confirmarExclusao(); }}
              disabled={excluindo}
              aria-busy={excluindo}
              className="orbita-chip cursor-pointer"
              style={{ background: 'var(--danger)', borderColor: 'var(--danger)', color: '#fff' }}
            >
              {excluindo && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {excluindo ? 'Excluindo…' : 'Excluir contato'}
            </button>
          }
        />
      ) : (
        <RodapeDeModal
          destrutiva={
            onExcluir && cliente.id && (
              <button
                type="button"
                onClick={() => { setAviso(null); setConfirmandoId(cliente.id ?? null); }}
                className="orbita-chip cursor-pointer"
                style={{ color: 'var(--danger)' }}
              >
                <Trash2 className="w-3.5 h-3.5" />
                Excluir
              </button>
            )
          }
          secundaria={
            <button type="button" onClick={fechar} className="orbita-chip cursor-pointer">
              Fechar
            </button>
          }
          primaria={
            onEdit && (
              <button
                type="button"
                onClick={() => onEdit(cliente)}
                className="orbita-chip cursor-pointer"
                style={{ background: 'var(--accent)', borderColor: 'var(--accent)', color: 'var(--accent-fg)' }}
              >
                <Pencil className="w-3.5 h-3.5" />
                Editar contato
              </button>
            )
          }
        />
      )}
    >
      {confirmando ? (
        <ConfirmacaoDeExclusao nome={cliente.nome} noBling={contatoNoBling(cliente)} aviso={aviso} />
      ) : (
      <div className="flex flex-col gap-6">
        <Pilula
          rotulo={cliente.bling_id ? 'Bling' : 'Só no Orbita'}
          cor={cliente.bling_id ? 'var(--accent)' : 'var(--txt3)'}
        />

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <Secao titulo="Contato">
            <Campo
              rotulo="Telefone"
              valor={cliente.telefone}
              mono
              aoCopiar={() => copiar(cliente.telefone!, 'telefone')}
              copiado={campoCopiado === 'telefone'}
            />
            <Campo
              rotulo="E-mail"
              valor={cliente.email}
              aoCopiar={() => copiar(cliente.email!, 'email')}
              copiado={campoCopiado === 'email'}
            />
            {onOpenChatwoot && cliente.telefone && (
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onOpenChatwoot(cliente.telefone, cliente.nome);
                }}
                className="orbita-chip cursor-pointer w-full justify-center mt-1"
              >
                <MessageCircle className="w-3.5 h-3.5" />
                Abrir no Chatwoot
              </button>
            )}
          </Secao>

          <Secao titulo="Documento & Endereço">
            <Campo
              rotulo="CPF / CNPJ"
              valor={cliente.cpf_cnpj}
              mono
              aoCopiar={() => copiar(cliente.cpf_cnpj!, 'documento')}
              copiado={campoCopiado === 'documento'}
            />
            <Campo rotulo="Endereço" valor={endereco} />
            <Campo rotulo="CEP" valor={cliente.cep} mono />
          </Secao>
        </div>
      </div>
      )}
    </Modal>
  );
}

/** O mesmo critério do servidor: só um `bling_id` numérico é vínculo com o Bling. */
function contatoNoBling(cliente: Cliente): boolean {
  return /^\d+$/u.test(String(cliente.bling_id ?? ''));
}

function ConfirmacaoDeExclusao({ nome, noBling, aviso }: { nome: string; noBling: boolean; aviso: string | null }) {
  return (
    <div className="flex flex-col gap-3 text-sm leading-relaxed" style={{ color: 'var(--txt2)' }}>
      <p className="m-0">
        O contato <strong style={{ color: 'var(--txt)' }}>{nome}</strong> será excluído definitivamente do ORBITA
        {noBling ? ' e também do Bling' : ''}. Esta ação não pode ser desfeita.
      </p>
      <p className="m-0 text-xs">
        Contatos com histórico vinculado — pedidos, por exemplo — não são excluídos: o histórico é preservado.
      </p>
      {aviso && (
        <p
          role="alert"
          className="m-0 px-4 py-2.5 text-xs"
          style={{ borderRadius: 'var(--r-chip)', background: 'var(--chip)', border: '1px solid var(--line)', color: 'var(--txt)' }}
        >
          {aviso}
        </p>
      )}
    </div>
  );
}
