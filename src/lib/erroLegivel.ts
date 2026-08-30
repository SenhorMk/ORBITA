/**
 * Tradução de um erro desconhecido para uma linha legível.
 *
 * O motivo de existir é literal: a sincronização registrou quatro vezes
 * seguidas `Primeira falha: [object Object]`. O `catch` fazia
 * `err instanceof Error ? err.message : String(err)`, e o que o
 * `supabase-js` lança num upsert recusado NÃO é um `Error` — é um
 * `PostgrestError`, objeto simples com `message`, `code`, `details` e `hint`.
 * `String()` de um objeto simples é `[object Object]`, então a única
 * informação que importava — o código SQL e a mensagem do Postgres — era
 * exatamente a que se perdia.
 *
 * Um erro ilegível não é um detalhe cosmético: foi ele que transformou
 * "42P10: there is no unique or exclusion constraint matching the ON CONFLICT
 * specification" num sintoma vago que não apontava para lugar nenhum.
 */

/** Formato do erro que o PostgREST devolve através do `supabase-js`. */
interface ErroPostgrest {
  message?: unknown;
  code?: unknown;
  details?: unknown;
  hint?: unknown;
}

function texto(valor: unknown): string | undefined {
  if (typeof valor !== 'string') return undefined;
  const limpo = valor.trim();
  return limpo.length > 0 ? limpo : undefined;
}

export function descreverErro(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err === null || err === undefined) return String(err);

  if (err instanceof Error) {
    const codigo = texto((err as unknown as ErroPostgrest).code);
    return codigo ? `[${codigo}] ${err.message}` : err.message;
  }

  if (typeof err === 'object') {
    const e = err as ErroPostgrest;
    const partes: string[] = [];
    const codigo = texto(e.code);
    const mensagem = texto(e.message);
    const detalhes = texto(e.details);
    const dica = texto(e.hint);

    if (codigo) partes.push(`[${codigo}]`);
    if (mensagem) partes.push(mensagem);
    if (detalhes) partes.push(`— ${detalhes}`);
    if (dica) partes.push(`(dica: ${dica})`);

    if (partes.length > 0) return partes.join(' ');

    // Último recurso: qualquer coisa é melhor que `[object Object]`.
    try {
      return JSON.stringify(err);
    } catch {
      return Object.prototype.toString.call(err);
    }
  }

  return String(err);
}
