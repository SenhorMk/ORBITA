'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import type { TabType } from './Rail';
import responsive from '@/components/ui/Responsive.module.css';

/** A rolagem da página pertence ao ERP; o cockpit conserva sua própria rolagem. */
export function AreaDeConteudo({ aba, ocupaJanela = true, children }: {
  aba: TabType;
  ocupaJanela?: boolean;
  children: ReactNode;
}) {
  const area = useRef<HTMLElement>(null);
  useEffect(() => {
    if (aba !== 'sac') area.current?.scrollTo?.({ top: 0, left: 0 });
  }, [aba]);
  return (
    <main ref={area} data-tela={aba} className={`${aba !== 'sac' ? responsive.viewport : ''} ${ocupaJanela
      ? 'flex-1 min-h-0 flex flex-col'
      : 'flex-1 min-h-0 overflow-y-auto space-y-6 pr-1'}`}>
      {children}
    </main>
  );
}
