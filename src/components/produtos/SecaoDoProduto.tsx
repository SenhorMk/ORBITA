import type { ReactNode } from 'react';

/** Título e ajuda compartilham a mesma linha, sem ocupar células dos campos. */
export function SecaoDoProduto({ titulo, children, ajuda }: {
  titulo: string;
  children: ReactNode;
  ajuda?: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <h4 className="orbita-eyebrow">{titulo}</h4>
        {ajuda}
      </div>
      {children}
    </section>
  );
}
