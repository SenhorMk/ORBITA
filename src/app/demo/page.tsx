'use client';

import dynamic from 'next/dynamic';

/**
 * DEMONSTRAÇÃO — só no navegador, sem renderização no servidor: os dados
 * fictícios dependem da hora atual e a página não fala com a rede.
 */
const DemoDoOrbita = dynamic(() => import('./DemoDoOrbita'), { ssr: false });

export default function Demo() {
  return <DemoDoOrbita />;
}
