import { z } from 'zod';

/** O id que o Bling emite (produto, contato): inteiro positivo, sem prefixo local (`LOCAL-…`, `temp_…`). */
export const idDoBlingSchema = z
  .union([z.number().int().positive().max(Number.MAX_SAFE_INTEGER), z.string().regex(/^[1-9][0-9]*$/)])
  .transform(String);

const dataDoEventoSchema = z.object({ date: z.string().datetime({ offset: true }) });

/** A data do evento no Bling (`date`), quando é uma data válida. */
export function dataDoEventoDoBling(eventRecord: Record<string, unknown>): string | null {
  const data = dataDoEventoSchema.safeParse(eventRecord);
  return data.success ? new Date(data.data.date).toISOString() : null;
}
