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

import { redactSensitiveData, redactSensitiveText } from './dadosSensiveis';

/** Formato do erro que o PostgREST devolve através do `supabase-js`. */
interface ErroPostgrest {
  message?: unknown;
  code?: unknown;
  details?: unknown;
  hint?: unknown;
}

/**
 * Normaliza um campo de texto do erro e **redige** segredos embutidos nele.
 *
 * Redigir aqui é o ponto certo: `message`, `details` e `hint` são texto livre
 * vindo de fora — um provedor que interpola o header da requisição na mensagem
 * de erro faz o segredo chegar por este caminho. A redação é por padrão de
 * chave e de forma (`Bearer …`, `Set-Cookie: …`, JWT), então o que é
 * diagnóstico continua inteiro: `42P10` e a mensagem do Postgres não casam com
 * padrão nenhum.
 */
function texto(valor: unknown): string | undefined {
  if (typeof valor !== 'string') return undefined;
  const limpo = redactSensitiveText(valor).trim();
  return limpo.length > 0 ? limpo : undefined;
}

/**
 * Formas de código que o ORBITA reconhece como **identificação técnica
 * confiável**. Fora desta lista, o código não é impresso.
 *
 * O `code` de um erro é atributo de um objeto que veio de fora. Antes ele ia
 * direto para dentro de `[...]`, e um authorization code do OAuth chega
 * exatamente assim — num objeto lançado, no campo `code`. Redigir por padrão de
 * segredo não bastava: o que não parece segredo passava mesmo sendo.
 *
 * A regra é inversa: só sai o que tem forma fechada e reconhecível.
 */
const CODIGOS_TECNICOS: ReadonlyArray<RegExp> = [
  /^[0-9A-Z]{5}$/u, // SQLSTATE do Postgres: 42P10, 42501, 23505
  /^PGRST\d{3}$/u, // PostgREST: PGRST201, PGRST116
  /^E[A-Z]{2,15}$/u, // errno do Node: ECONNREFUSED, ETIMEDOUT
];

/** Código do erro, apenas quando tem forma técnica reconhecível. */
function codigoTecnico(valor: unknown): string | undefined {
  if (typeof valor !== 'string') return undefined;
  const limpo = valor.trim();
  return CODIGOS_TECNICOS.some((forma) => forma.test(limpo)) ? limpo : undefined;
}

export function descreverErro(err: unknown): string {
  // Texto cru tambem passa pela politica: quem lanca string em vez de Error
  // contornava a redacao inteira por este ramo.
  if (typeof err === 'string') return redactSensitiveText(err);
  if (err === null || err === undefined) return String(err);

  if (err instanceof Error) {
    // `in` estreita o tipo sem asserção: um Error pode carregar `code`
    // (o `errno` do Node, por exemplo) e a asserção dupla que estava aqui
    // desligava a checagem em vez de fazer a pergunta.
    const codigo = 'code' in err ? codigoTecnico(err.code) : undefined;
    const mensagem = redactSensitiveText(err.message);
    return codigo ? `[${codigo}] ${mensagem}` : mensagem;
  }

  if (typeof err === 'object') {
    const e = err as ErroPostgrest;
    const partes: string[] = [];
    const codigo = codigoTecnico(e.code);
    const mensagem = texto(e.message);
    const detalhes = texto(e.details);
    const dica = texto(e.hint);

    if (codigo) partes.push(`[${codigo}]`);
    if (mensagem) partes.push(mensagem);
    if (detalhes) partes.push(`— ${detalhes}`);
    if (dica) partes.push(`(dica: ${dica})`);

    if (partes.length > 0) return partes.join(' ');

    // Último recurso: qualquer coisa é melhor que `[object Object]` — mas o
    // objeto vai inteiro para o log e, em vários pontos, para a tela. Um erro
    // que carregue `access_token` ou `client_secret` vazaria por aqui, então
    // as chaves sensíveis são redigidas antes.
    try {
      return JSON.stringify(redactSensitiveData(err));
    } catch {
      return Object.prototype.toString.call(err);
    }
  }

  return String(err);
}
