'use client';

import * as Dialog from '@radix-ui/react-dialog';
import { useLayoutEffect, useState } from 'react';
import { CircleHelp, X } from 'lucide-react';
import { catalogoDeAjuda, type AjudaId } from './catalogo';
import styles from './HelpInfo.module.css';

/** Ajuda por clique/toque/teclado. O Radix mantém foco, Escape e retorno ao acionador. */
export function HelpInfo({ ajudaId }: { readonly ajudaId: AjudaId }) {
  const ajuda = catalogoDeAjuda[ajudaId];
  const [aberta, setAberta] = useState(false);

  useLayoutEffect(() => {
    if (!aberta) return;
    // A camada Radix de origem pode manter o listener de Escape até seu próximo
    // efeito passivo. Interceptar no window, antes do document, evita fechar os
    // dois diálogos quando Escape chega logo depois da abertura da ajuda.
    const fecharAjuda = (evento: KeyboardEvent) => {
      if (evento.key !== 'Escape') return;
      evento.preventDefault();
      evento.stopPropagation();
      setAberta(false);
    };
    window.addEventListener('keydown', fecharAjuda, true);
    return () => window.removeEventListener('keydown', fecharAjuda, true);
  }, [aberta]);

  return (
    <Dialog.Root open={aberta} onOpenChange={setAberta}>
      <Dialog.Trigger asChild>
        <button type="button" className={styles.trigger} aria-label={`Ajuda: ${ajuda.titulo}`} data-help-id={ajudaId}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') event.stopPropagation(); }}>
          <CircleHelp size={18} aria-hidden="true" />
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} onClick={(event) => event.stopPropagation()} />
        <Dialog.Content className={styles.content} onClick={(event) => event.stopPropagation()} style={{
          backdropFilter: 'blur(var(--blur-modal)) saturate(1.4)',
          WebkitBackdropFilter: 'blur(var(--blur-modal)) saturate(1.4)',
        }}>
          <header className={styles.header}>
            <Dialog.Title className={styles.title}>{ajuda.titulo}</Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" className={styles.close} aria-label="Fechar ajuda"><X size={18} aria-hidden="true" /></button>
            </Dialog.Close>
          </header>
          <Dialog.Description className={styles.description}>{ajuda.oQueE}</Dialog.Description>
          <h3>Como usar</h3><p>{ajuda.comoUsar}</p>
          <h3>Após a ação</h3><p>{ajuda.depois}</p>
          <h3>Atenção</h3><p>{ajuda.atencao}</p>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
