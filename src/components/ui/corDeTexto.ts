const TEXTO_POR_COR: Readonly<Record<string, string>> = {
  'var(--accent)': 'var(--texto-acento, var(--accent))',
  'var(--danger)': 'var(--texto-perigo, var(--danger))',
  'var(--info)': 'var(--texto-info, var(--info))',
  'var(--warning)': 'var(--texto-atencao, var(--warning))',
};

/** O texto pode escurecer no tema claro sem mudar o acento de pontos e gráficos. */
export function corDeTexto(cor: string): string {
  return TEXTO_POR_COR[cor] ?? cor;
}
