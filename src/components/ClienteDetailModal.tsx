'use client';

import { useState } from "react";
import { CheckCircle2, Copy, MessageCircle, Pencil, Trash2 } from 'lucide-react';
import { Modal, RodapeDeModal } from '@/components/ui/modal';
import { Pilula } from '@/components/ui/StatusPill';
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
 * - **excluir** um contato: `onDelete` **não tem chamador** — a tela não passa
 *   essa prop, então a exclusão não está exposta na interface. O botão que este
 *   componente sabe desenhar é uma possibilidade, não algo que a tela oferece;
 *   ligá-lo seria adicionar um fluxo destrutivo.
 *
 * O mesmo vale para produto: `POST /api/produtos/delete` existe no servidor, e
 * nenhuma tela o chama.
 */

interface ClienteDetailModalProps {
  isOpen: boolean;
  onClose: () => void;
  cliente: Cliente | null;
  onOpenChatwoot?: (phone?: string, name?: string) => void;
  onEdit?: (cliente: Cliente) => void;
  onDelete?: (id: string, blingId?: string) => void;
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
  onDelete
}: ClienteDetailModalProps) {
  const [campoCopiado, setCampoCopiado] = useState<string | null>(null);

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
        if (!aberto) onClose();
      }}
      tamanho="lg"
      eyebrow="Contato"
      titulo={cliente.nome}
      descricao="Detalhes do contato, como estão no Orbita e no Bling."
      rodape={
        <RodapeDeModal
          destrutiva={
            onDelete && (
              <button
                type="button"
                onClick={() => {
                  if (confirm('Tem certeza que deseja excluir este contato no Bling e no sistema local? Essa ação não pode ser desfeita.')) {
                    onDelete(cliente.id!, cliente.bling_id);
                  }
                }}
                className="orbita-chip cursor-pointer"
                style={{ color: 'var(--danger)' }}
              >
                <Trash2 className="w-3.5 h-3.5" />
                Excluir
              </button>
            )
          }
          secundaria={
            <button type="button" onClick={onClose} className="orbita-chip cursor-pointer">
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
      }
    >
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
    </Modal>
  );
}
