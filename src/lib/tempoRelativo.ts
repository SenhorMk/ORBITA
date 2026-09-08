/**
 * Quanto tempo passou desde `momento`, em texto curto.
 *
 * Só descreve o que é conhecido. Nunca arredonda para um horário que não
 * aconteceu, e nunca inventa "agora" quando não há nada registrado — quem não
 * tem o momento não chama esta função, diz que não sabe.
 */
export function descreverTempoDesde(momento: Date, agora: number = Date.now()): string {
  const segundos = Math.max(0, Math.floor((agora - momento.getTime()) / 1000));
  if (segundos < 60) return 'há instantes';
  const minutos = Math.floor(segundos / 60);
  if (minutos < 60) return `há ${minutos} min`;
  const horas = Math.floor(minutos / 60);
  if (horas < 24) return `há ${horas} h`;
  const dias = Math.floor(horas / 24);
  return dias === 1 ? 'há 1 dia' : `há ${dias} dias`;
}

/** A idade de uma data ISO, ou `null` quando a data não dá para ler. */
export function idadeDeIso(iso: string | null | undefined, agora: number = Date.now()): string | null {
  if (!iso) return null;
  const quando = new Date(iso);
  if (!Number.isFinite(quando.getTime())) return null;
  return descreverTempoDesde(quando, agora);
}
