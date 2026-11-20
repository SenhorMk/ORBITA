import { useEffect, useState } from 'react';

/**
 * - `amplo`: lista, conversa e painel lado a lado;
 * - `medio`: lista e conversa; com o painel aberto, a lista cede o lugar a ele;
 * - `compacto`: uma tela por vez (lista ou conversa) e o painel numa folha.
 */
export type ModoDoLayout = 'amplo' | 'medio' | 'compacto';

/** Abaixo disso, lista e conversa não cabem lado a lado com leitura confortável. */
export const LARGURA_MINIMA_DE_DUAS_COLUNAS = 720;
/**
 * A partir disso, o painel cabe ao lado da lista e da conversa deixando a
 * conversa com mais de ~600 px. Abaixo (1366 × 768, por exemplo), o painel
 * toma o lugar da lista enquanto estiver aberto.
 */
export const LARGURA_MINIMA_DO_PAINEL_AO_LADO = 1320;

export function modoParaLargura(largura: number | null): ModoDoLayout {
  // Sem medida (primeiro render, ou ambiente sem ResizeObserver): o layout de mesa.
  if (largura === null) return 'amplo';
  if (largura < LARGURA_MINIMA_DE_DUAS_COLUNAS) return 'compacto';
  return largura < LARGURA_MINIMA_DO_PAINEL_AO_LADO ? 'medio' : 'amplo';
}

/**
 * O modo pela largura **da própria central**, e não da janela do navegador: a
 * janela do ORBITA tem rail e margens que mudam por faixa. Devolve o modo e o
 * `ref` de callback a pôr no elemento medido (que pode montar depois).
 */
export function useModoDoLayout(): readonly [ModoDoLayout, (elemento: HTMLElement | null) => void] {
  const [elemento, setElemento] = useState<HTMLElement | null>(null);
  const [largura, setLargura] = useState<number | null>(null);
  useEffect(() => {
    if (elemento === null || typeof ResizeObserver === 'undefined') return undefined;
    const observador = new ResizeObserver((entradas) => {
      const medida = entradas[0]?.contentRect.width;
      if (typeof medida === 'number') setLargura(Math.round(medida));
    });
    observador.observe(elemento);
    return () => observador.disconnect();
  }, [elemento]);
  return [modoParaLargura(largura), setElemento] as const;
}
