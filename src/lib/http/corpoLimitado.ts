/** Corpo lido como bytes crus, ou a recusa por passar do limite. */
export type CorpoLido =
  | { readonly _tag: 'CorpoLido'; readonly bytes: Uint8Array }
  | { readonly _tag: 'CorpoGrandeDemais' };

/**
 * Lê o corpo da requisição como bytes, sem decodificar, parando assim que
 * passar de `limiteBytes`: um corpo enorme não chega a ficar inteiro na
 * memória. Os bytes são os mesmos que o remetente assinou.
 */
export async function lerCorpoLimitado(request: Request, limiteBytes: number): Promise<CorpoLido> {
  const declarado = Number(request.headers.get('content-length'));
  if (Number.isFinite(declarado) && declarado > limiteBytes) return { _tag: 'CorpoGrandeDemais' };
  if (!request.body) return { _tag: 'CorpoLido', bytes: new Uint8Array() };

  const reader = request.body.getReader();
  const partes: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limiteBytes) {
      await reader.cancel();
      return { _tag: 'CorpoGrandeDemais' };
    }
    partes.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const parte of partes) {
    bytes.set(parte, offset);
    offset += parte.byteLength;
  }
  return { _tag: 'CorpoLido', bytes };
}
