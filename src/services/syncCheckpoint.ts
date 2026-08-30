import { supabaseServer } from '../lib/supabaseServer';

/**
 * Marcadores de progresso e utilitários de paginação da sincronização.
 *
 * Extraídos de `sync.ts` para manter cada arquivo dentro do limite do gate de
 * qualidade — e porque o checkpoint merece um lugar próprio: foi ele que, ao
 * avançar depois de uma leitura que falhava em silêncio, transformou um erro
 * momentâneo numa sincronização permanentemente vazia.
 */

export async function getLastSyncedAt(orgId: string, entidade: string): Promise<string | null> {
  const { data } = await supabaseServer
    .from('sync_state')
    .select('last_synced_at')
    .eq('entidade', entidade)
    .eq('organizacao_id', orgId)
    .maybeSingle();
  return data?.last_synced_at ?? null;
}

export async function touchSyncState(orgId: string, userId: string, entidade: string): Promise<void> {
  const now = new Date().toISOString();
  await supabaseServer
    .from('sync_state')
    .upsert(
      {
        organizacao_id: orgId,
        user_id: userId,
        entidade,
        last_synced_at: now,
        updated_at: now,
      },
      { onConflict: 'organizacao_id, entidade' },
    );
}

export function getBlingDateTime(isoString?: string | null): string | undefined {
  if (!isoString) return undefined;
  const d = new Date(isoString);
  const formatter = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(d);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

export async function syncPaginatedEntities<T>(
  fetchPage: (page: number) => Promise<T[]>,
  processItem: (item: T) => Promise<void>,
  onPageDone: (page: number, count: number) => Promise<void>,
): Promise<number> {
  let total = 0;
  let page = 1;
  let falhas = 0;
  let primeiraFalha: string | undefined;
  while (true) {
    const items = await fetchPage(page);
    if (items.length === 0) break;

    let falhasNaPagina = 0;
    for (const item of items) {
      try {
        await processItem(item);
        total++;
      } catch (itemErr: unknown) {
        falhasNaPagina += 1;
        falhas += 1;
        primeiraFalha ??= itemErr instanceof Error ? itemErr.message : String(itemErr);
      }
    }

    // Um item que falha e tolerável; a página inteira falhando é um defeito
    // sistemático — coluna que não existe, constraint violada, permissão
    // negada. Antes isso virava só `console.warn`, e a etapa concluía com
    // total zero: a sincronização dizia "Sincronizado! 0 produtos" com o
    // catálogo cheio no Bling, para sempre.
    if (falhasNaPagina === items.length) {
      throw new Error(
        `nenhum dos ${items.length} registros da página ${page} pôde ser gravado. Primeira falha: ${primeiraFalha}`,
      );
    }

    await onPageDone(page, total);
    page++;
    if (items.length < 100) break;
  }

  if (falhas > 0) {
    console.warn(`[sync] ${falhas} registro(s) não puderam ser gravados. Primeira falha: ${primeiraFalha}`);
  }

  return total;
}
