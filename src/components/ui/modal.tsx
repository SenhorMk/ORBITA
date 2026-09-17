'use client';

import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * Os quatro tamanhos do Design System. Não há um quinto: se um diálogo não
 * couber em nenhum deles, a pergunta é sobre o diálogo, não sobre o tamanho.
 */
export type TamanhoDoModal = 'sm' | 'md' | 'lg' | 'drawer';

/**
 * `drawer` sai do token de geometria: o protótipo o estreita junto com a janela
 * (640 / 560 / 470). Os outros três são fixos — um formulário não fica melhor
 * por ser mais largo num monitor maior.
 */
const LARGURA: Record<TamanhoDoModal, string> = {
  sm: '440px',
  md: '560px',
  lg: '720px',
  drawer: 'var(--drawer-w)',
};

export interface ModalProps {
  aberto: boolean;
  onAbertoChange: (aberto: boolean) => void;
  /** `sm` 440 · `md` 560 · `lg` 720 · `drawer` 520 ancorado à direita. */
  tamanho?: TamanhoDoModal;
  /** A linha mono acima do título. Vermelha quando `destrutivo`. */
  eyebrow?: ReactNode;
  titulo: ReactNode;
  /** Lida por leitores de tela; exigida pelo Radix mesmo quando não aparece. */
  descricao?: string;
  /** Esconde a descrição visualmente, mantendo-a acessível. */
  descricaoOculta?: boolean;
  destrutivo?: boolean;
  /**
   * Fecha ao clicar fora e no ESC. Padrão `true`.
   *
   * `false` em multi-step e em conflito — são os dois casos que a seção 04 do
   * Design System tira da regra, porque fechar sem querer perde uma decisão que
   * a pessoa ainda não tomou.
   */
  dispensavel?: boolean;
  /** Ação primária à direita; destrutiva sozinha à esquerda. */
  rodape?: ReactNode;
  children: ReactNode;
}

/**
 * O único diálogo do Orbita.
 *
 * Uma anatomia só — eyebrow, título, corpo, rodapé — para os quatro tamanhos.
 * O comportamento (foco preso, ESC, `aria-modal`, restauração de foco ao
 * fechar) é o do Radix, o mesmo que os diálogos legados já usavam: aqui só
 * compõem-se as partes com os tokens do Design System, sem empilhar um diálogo
 * dentro do outro.
 *
 * O overlay cobre a **janela**, não o viewport: ele usa os mesmos insets do
 * shell, então o fundo escolhido pela pessoa continua aparecendo em volta e o
 * drawer ancora na borda da janela, como no mockup.
 */
export function Modal({
  aberto,
  onAbertoChange,
  tamanho = 'md',
  eyebrow,
  titulo,
  descricao,
  descricaoOculta = true,
  destrutivo = false,
  dispensavel = true,
  rodape,
  children,
}: ModalProps) {
  const ehDrawer = tamanho === 'drawer';
  const naoDispensar = dispensavel ? undefined : (evento: Event) => evento.preventDefault();

  return (
    <DialogPrimitive.Root open={aberto} onOpenChange={onAbertoChange}>
      <DialogPrimitive.Portal>
        {/* O blur vai inline: o pipeline de CSS do projeto descarta
            `backdrop-filter` de qualquer folha de estilo (ver `AppWindow`). */}
        <DialogPrimitive.Overlay
          className="orbita-overlay"
          style={{
            backdropFilter: 'blur(var(--blur-overlay))',
            WebkitBackdropFilter: 'blur(var(--blur-overlay))',
          }}
        />
        <DialogPrimitive.Content
          className={ehDrawer ? 'orbita-modal orbita-modal--drawer' : 'orbita-modal'}
          style={{
            width: LARGURA[tamanho],
            backdropFilter: 'blur(var(--blur-modal)) saturate(1.4)',
            WebkitBackdropFilter: 'blur(var(--blur-modal)) saturate(1.4)',
          }}
          onEscapeKeyDown={naoDispensar}
          onPointerDownOutside={naoDispensar}
          onInteractOutside={naoDispensar}
        >
          <header className="flex items-start justify-between gap-4 px-6 pt-5 pb-4" style={{ borderBottom: '1px solid var(--line)' }}>
            <div className="flex flex-col gap-1.5 min-w-0">
              {eyebrow && (
                <span className="orbita-eyebrow" style={destrutivo ? { color: 'var(--danger)' } : undefined}>
                  {eyebrow}
                </span>
              )}
              <DialogPrimitive.Title
                className="text-[23px] leading-tight font-semibold tracking-tight truncate"
                style={{ fontFamily: 'var(--font-space-grotesk), sans-serif', color: 'var(--txt)' }}
              >
                {titulo}
              </DialogPrimitive.Title>
              {descricao && !descricaoOculta && (
                <DialogPrimitive.Description className="text-xs" style={{ color: 'var(--txt2)' }}>
                  {descricao}
                </DialogPrimitive.Description>
              )}
            </div>
            {descricao && descricaoOculta && (
              <DialogPrimitive.Description className="sr-only">{descricao}</DialogPrimitive.Description>
            )}
            <DialogPrimitive.Close
              aria-label="Fechar"
              className="w-8 h-8 shrink-0 rounded-xl flex items-center justify-center cursor-pointer"
              style={{ background: 'var(--chip)', border: '1px solid var(--line)', color: 'var(--txt2)' }}
            >
              <X className="w-4 h-4" />
            </DialogPrimitive.Close>
          </header>

          <div className="px-6 py-5 overflow-y-auto flex-1">{children}</div>

          {rodape && (
            <footer
              className="flex items-center justify-between gap-3 px-6 py-4"
              style={{ borderTop: '1px solid var(--line)' }}
            >
              {rodape}
            </footer>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/**
 * O par de ações do rodapé.
 *
 * A primária é a última na ordem de foco e fica no canto inferior direito; a
 * destrutiva fica sozinha à esquerda, longe dela. Isso não é diagramação: é o
 * que impede que "cancelar o pedido" e "salvar" fiquem coladas.
 *
 * `esquerda` é o mesmo grupo da destrutiva, para a decisão que **muda o que a
 * ação primária faz** — não uma ação, um interruptor. Ela mora aqui, e não no
 * corpo, porque o corpo rola: a 1366×768 o interruptor de "sincronizar com o
 * Bling" ficaria abaixo da dobra do modal de venda manual, e quem não rolasse
 * apertaria "Finalizar" sem ver que aquilo escreve no ERP. Uma escolha que não
 * está na tela na hora de decidir não é uma escolha. O rodapé não rola nunca.
 */
export function RodapeDeModal({
  destrutiva,
  esquerda,
  secundaria,
  primaria,
}: {
  destrutiva?: ReactNode;
  esquerda?: ReactNode;
  secundaria?: ReactNode;
  primaria?: ReactNode;
}) {
  return (
    <>
      <div className="flex items-center gap-3 min-w-0">
        {destrutiva}
        {esquerda}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {secundaria}
        {primaria}
      </div>
    </>
  );
}
