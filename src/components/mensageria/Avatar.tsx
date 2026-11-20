import estilos from './mensageria.module.css';

/** As iniciais de um contato, ou o marcador de atendimento quando não há nome. */
export function Avatar({ nome, tamanho }: { readonly nome: string | undefined; readonly tamanho: number }) {
  return (
    <span
      className={estilos.avatar}
      aria-hidden
      style={{
        width: tamanho,
        height: tamanho,
        borderRadius: Math.round(tamanho / 3),
        font: `600 ${Math.round(tamanho / 3)}px/1 var(--font-archivo), sans-serif`,
      }}
    >
      {nome && nome.trim() ? nome.trim().substring(0, 2).toUpperCase() : 'SA'}
    </span>
  );
}

export function horaCurta(iso: string | undefined): string {
  if (!iso) return '';
  const data = new Date(iso);
  return Number.isNaN(data.getTime()) ? '' : data.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}
