/**
 * Política única de redação de dados sensíveis.
 *
 * Existiam **duas** implementações divergentes: uma em
 * `lib/integrations/credentialsVault.ts` (lista exata de chaves) e outra em
 * `lib/observability/logger.ts` (padrão de expressão regular, mais larga, com
 * redação de texto livre). Quem chamasse a primeira ficava sem `cookie`, sem
 * `set-cookie` e sem qualquer variante camelCase — a lista tinha
 * `webhook_secret`, e a normalização que removia `_` produzia `webhooksecret`,
 * que não estava na lista. `webhookSecret` passava em claro.
 *
 * Duas políticas para o mesmo risco é a família de defeito desta série:
 * fronteira testada de um lado só. Agora existe uma, aqui, e os dois módulos
 * antigos reexportam desta — renomear ou afrouxar a regra passa a valer para
 * todos os chamadores de uma vez.
 *
 * Mora numa folha sem dependência nenhuma porque `descreverErro`
 * (`lib/erroLegivel.ts`) precisa dela, e `erroLegivel` é importado por
 * componentes de interface: importar o cofre de credenciais de dentro de um
 * componente arrastaria `crypto` e o cliente Supabase de servidor para o
 * bundle do navegador.
 */

/**
 * Nomes de campo cujo **valor** nunca pode aparecer em log, mensagem de erro ou
 * resposta. É expressão regular, e não lista exata, justamente para pegar
 * `webhookSecret`, `set-cookie`, `blingAccessToken` e as demais variantes que
 * uma lista fechada deixaria passar.
 */
const SENSITIVE_KEY_PATTERN = /(password|senha|secret|token|authorization|cookie|apiKey|api_key|client_secret|access_token|refresh_token|dados_cifrados|card|cvv|cpf|cnpj|^state$|^code$|oauth_state|oauth_code)/i;

/**
 * Segredos que aparecem embutidos em **texto livre** — mensagem de `Error` de
 * uma biblioteca que interpolou um header, corpo de resposta de provedor, dump
 * de requisição — fora da estrutura chave/valor.
 *
 * Cada padrão redige **apenas o valor**, preservando o prefixo. Isso é o que
 * mantém a mensagem útil: `[42P10] there is no unique or exclusion constraint`
 * não casa com nenhum padrão daqui e chega intacta.
 */
const INLINE_SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  // Authorization: Bearer/Basic <token>
  /\b(Authorization\s*[:=]\s*(?:Bearer|Basic)\s+)([^\s,;]+)/gi,
  // `Bearer <token>` solto, sem o nome do header antes
  /\b(Bearer\s+)([A-Za-z0-9._~+/-]{12,}={0,2})/g,
  // Set-Cookie / Cookie: <valor>
  /\b((?:Set-)?Cookie\s*[:=]\s*)([^\s,;]+)/gi,
  // JWT: três segmentos base64url começando por `eyJ`
  /\b(eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.)([A-Za-z0-9_-]+)/g,
  // key=value ou key: value onde a chave é sensível
  /\b((?:password|senha|secret|token|apiKey|api_key|client_secret|access_token|refresh_token|webhook_secret|webhookSecret|cvv|cpf|cnpj|oauth_state|oauth_code)\s*[:=]\s*)([^\s,;]+)/gi,
];

/** `true` quando o valor deste campo nunca pode ser exibido. */
export function chaveSensivel(chave: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(chave);
}

/**
 * Redige segredos embutidos numa string livre.
 *
 * Não sanitiza estrutura — para objeto e array, `redactSensitiveData`.
 */
export function redactSensitiveText(text: string): string {
  let result = text;
  for (const pattern of INLINE_SECRET_PATTERNS) {
    result = result.replace(pattern, (_match, prefixo: string) => `${prefixo}[REDACTED]`);
  }
  return result;
}

/**
 * Redige recursivamente os valores de campos sensíveis, e também os segredos
 * embutidos nos valores de texto que sobram.
 *
 * Redigir só a chave não bastava: um campo `message` legítimo pode carregar um
 * header inteiro no corpo do texto.
 */
export function redactSensitiveData(data: unknown, seen = new WeakSet()): unknown {
  if (data === null || data === undefined) return data;
  if (typeof data === 'string') return redactSensitiveText(data);
  if (typeof data !== 'object') return data;

  if (seen.has(data as object)) {
    return '[CIRCULAR]';
  }
  seen.add(data as object);

  if (Array.isArray(data)) {
    return data.map((item) => redactSensitiveData(item, seen));
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (chaveSensivel(key)) {
      redacted[key] = '[REDACTED]';
    } else if (typeof value === 'string') {
      redacted[key] = redactSensitiveText(value);
    } else if (typeof value === 'object' && value !== null) {
      redacted[key] = redactSensitiveData(value, seen);
    } else {
      redacted[key] = value;
    }
  }

  return redacted;
}
