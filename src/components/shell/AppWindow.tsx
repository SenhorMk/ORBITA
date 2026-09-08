'use client';

import type { ReactNode } from 'react';

/**
 * A janela do Orbita: uma superfície translúcida única, flutuando sobre o
 * fundo escolhido, com margem visível nos quatro lados.
 *
 * Isto é o nível 1 da escada de elevação do Design System e o **único** blur
 * pesado da tela. As medidas (inset assimétrico, raio 34, blur 48 saturate 1.4,
 * sombra) vivem em `tokens.css`; aqui só existe a composição.
 *
 * O fundo aparecer nos quatro lados não é decoração: sem ele o vidro não lê
 * como vidro, e a janela vira só um retângulo escuro.
 */
export function AppWindow({ children }: { children: ReactNode }) {
  return (
    <div
      className="orbita-window"
      // O blur vem por estilo inline, e não da classe, porque o transformador de
      // CSS do projeto descarta `backdrop-filter` de qualquer folha de estilo.
      // Foi assim que os utilitários `glass-*` do produto atual passaram a
      // existência inteira declarando um vidro que nunca borrou nada. Estilo
      // inline não passa por esse transformador.
      style={{
        backdropFilter: 'blur(var(--blur-window)) saturate(1.4)',
        WebkitBackdropFilter: 'blur(var(--blur-window)) saturate(1.4)',
      }}
    >
      {children}
    </div>
  );
}
