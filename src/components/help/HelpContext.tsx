'use client';

import type { ReactNode } from 'react';
import { HelpInfo } from './HelpInfo';
import type { AjudaId } from './catalogo';
import styles from './HelpInfo.module.css';

/** Cabeçalhos com indicadores passam a duas linhas quando a tela é estreita. */
export const helpPageHeader = styles.pageHeader;

/** Mantém título, rótulo ou ação e sua ajuda no mesmo grupo de layout. */
export function HelpContext({ ajudaId, children, as: Tag = 'div', className = '' }: {
  readonly ajudaId: AjudaId;
  readonly children: ReactNode;
  readonly as?: 'div' | 'span';
  readonly className?: string;
}) {
  return <Tag className={`${styles.context} ${className}`}>{children}<HelpInfo ajudaId={ajudaId} /></Tag>;
}
