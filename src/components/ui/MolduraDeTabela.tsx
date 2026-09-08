'use client';

import type { ReactNode } from 'react';

/**
 * A casca de uma tabela do Orbita: painel arredondado, área rolável e rodapé.
 *
 * **Não é um `DataTable`.** Não recebe colunas, nem dados, nem renderizadores —
 * só a moldura. As colunas de Estoque e as de Clientes são fixas e conhecidas, e
 * cada tela escreve as suas; o que as duas repetiriam é este contorno, e só ele
 * foi extraído. Vendas tem a mesma casca escrita à mão e continua como está: a
 * fatia que a migrou já estava fechada, e reabri-la por estética custaria mais
 * risco do que as vinte linhas que ela repete.
 */
export function MolduraDeTabela({
  /** A soma das colunas na geometria mais estreita — abaixo disso, rola dentro da moldura. */
  larguraMinima,
  rodape,
  children,
}: {
  larguraMinima: number;
  rodape: string;
  children: ReactNode;
}) {
  return (
    <div
      className="flex flex-col flex-1 min-h-0 overflow-hidden"
      style={{ borderRadius: 22, background: 'var(--glass2)', border: '1px solid var(--line)' }}
    >
      <div className="flex-1 min-h-0 overflow-auto" style={{ scrollbarGutter: 'stable' }}>
        <div style={{ minWidth: larguraMinima }}>{children}</div>
      </div>

      <div
        className="flex items-center justify-between flex-none"
        style={{ padding: '11px var(--tabela-pad)', borderTop: '1px solid var(--line)' }}
      >
        <span style={{ font: '400 11.5px/1 var(--font-archivo), sans-serif', color: 'var(--txt3)' }}>
          {rodape}
        </span>
      </div>
    </div>
  );
}
