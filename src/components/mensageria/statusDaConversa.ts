/**
 * Status da conversa no Chatwoot: `open`, `pending` ou `resolved`.
 *
 * `pending` não é resolvida: é a conversa que a integração ORBITA deixou com a
 * automação (a IA marca a conversa como pendente ao assumir a triagem). Antes,
 * o cockpit tratava todo status diferente de `open` como "Resolvida", e as
 * conversas atendidas pela IA sumiam do filtro "Abertos".
 */
export type StatusDaConversa = 'open' | 'pending' | 'resolved';

/** Resolvida só quando o Chatwoot diz `resolved`; status desconhecido não esconde a conversa. */
export function estaResolvida(status: string | null | undefined): boolean {
  return status === 'resolved';
}

/** O que aparece para o atendente. */
export function rotuloDoStatus(status: string | null | undefined): string {
  if (status === 'resolved') return 'Resolvida';
  if (status === 'pending') return 'Pendente';
  return 'Aberta';
}

/** O filtro da lista: "Abertos" é tudo o que ainda não foi resolvido (inclui `pending`). */
export function passaNoFiltro(status: string | null | undefined, filtro: 'open' | 'resolved' | 'all'): boolean {
  if (filtro === 'all') return true;
  return filtro === 'resolved' ? estaResolvida(status) : !estaResolvida(status);
}

/** Resolver ou reabrir: a ação do cabeçalho sempre leva para o oposto de "resolvida". */
export function proximoStatus(status: string | null | undefined): 'open' | 'resolved' {
  return estaResolvida(status) ? 'open' : 'resolved';
}
