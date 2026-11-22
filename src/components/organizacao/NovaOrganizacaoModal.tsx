'use client';

import { useState } from 'react';

import { Modal, RodapeDeModal } from '@/components/ui/modal';
import { HelpInfo } from '@/components/help/HelpInfo';

const ID_DO_FORMULARIO = 'form-nova-organizacao';

/**
 * O slug canônico: minúsculas, dígitos e hífens.
 *
 * A decomposição em NFD separa a acentuação da letra, e a faixa de marcas
 * combinantes some no passo seguinte — "Ação" vira "acao" em vez de "a-o". A
 * validação de verdade continua no servidor; isto é conveniência de digitação.
 */
function sugerirSlug(nome: string): string {
  return nome
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export interface NovaOrganizacaoModalProps {
  aberto: boolean;
  onAbertoChange: (aberto: boolean) => void;
  /** Cria no servidor. `true` quando a organização foi criada. */
  onCriar: (nome: string, slug: string) => Promise<boolean>;
  /** A falha da criação, dita pelo servidor. */
  erro: string | null;
}

/**
 * A criação de uma organização nova.
 *
 * O slug é **sugerido** a partir do nome enquanto ninguém o editou à mão, e
 * passa a ser respeitado no primeiro toque. A validação de negócio continua
 * inteira no servidor (`createOrgInputSchema`): a sugestão daqui é conveniência
 * de digitação, e não uma segunda regra sobre o que é um slug válido.
 */
export function NovaOrganizacaoModal({ aberto, onAbertoChange, onCriar, erro }: NovaOrganizacaoModalProps) {
  const [nome, setNome] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEditado, setSlugEditado] = useState(false);
  const [criando, setCriando] = useState(false);

  /**
   * O formulário nasce vazio a cada abertura. A limpeza mora aqui, e não num
   * efeito, porque todo caminho de fechamento — botão, X, ESC, clique fora —
   * passa por este handler.
   */
  function mudarAberto(proximo: boolean) {
    if (!proximo) {
      setNome('');
      setSlug('');
      setSlugEditado(false);
    }
    onAbertoChange(proximo);
  }

  async function handleSubmit(evento: React.FormEvent) {
    evento.preventDefault();
    setCriando(true);
    try {
      const criou = await onCriar(nome.trim(), slug.trim());
      if (criou) mudarAberto(false);
    } finally {
      setCriando(false);
    }
  }

  return (
    <Modal
      aberto={aberto}
      onAbertoChange={mudarAberto}
      tamanho="md"
      eyebrow="Nova organização"
      titulo="Criar organização"
      descricao="Dê um nome à organização. Você entra nela como dono."
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
              disabled={criando}
              className="orbita-acao"
              style={{ background: 'var(--accent)', borderColor: 'var(--accent)', color: 'var(--accent-fg)' }}
            >
              {criando ? 'Criando…' : 'Criar organização'}
            </button>
          }
        />
      }
     ajuda={<HelpInfo ajudaId="org.criar" />}>

      <form id={ID_DO_FORMULARIO} onSubmit={handleSubmit} className="flex flex-col" style={{ gap: 14 }}>
        <div className="flex flex-col" style={{ gap: 6 }}>
          <label htmlFor="org-nome" className="orbita-eyebrow">Nome da organização</label>
          <input
            id="org-nome"
            value={nome}
            onChange={(evento) => {
              setNome(evento.target.value);
              if (!slugEditado) setSlug(sugerirSlug(evento.target.value));
            }}
            className="orbita-campo"
            required
          />
        </div>

        <div className="flex flex-col" style={{ gap: 6 }}>
          <label htmlFor="org-slug" className="orbita-eyebrow">Slug</label>
          <input
            id="org-slug"
            value={slug}
            onChange={(evento) => { setSlugEditado(true); setSlug(evento.target.value); }}
            className="orbita-campo orbita-campo--mono"
            autoComplete="off"
            spellCheck={false}
            required
          />
          <p className="text-xs" style={{ color: 'var(--txt3)' }}>
            Identificador curto da organização. Sugerido pelo nome; edite se quiser outro.
          </p>
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
