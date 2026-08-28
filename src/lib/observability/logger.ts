export type LogSubsystem = 'app' | 'database' | 'queue' | 'provider';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogContext {
  subsystem?: LogSubsystem;
  correlationId?: string;
  organizacaoId?: string;
  actorId?: string;
  [key: string]: unknown;
}

const SENSITIVE_KEY_PATTERN = /(password|secret|token|authorization|cookie|apiKey|api_key|client_secret|access_token|refresh_token|card|cvv|cpf|cnpj|^state$|^code$|oauth_state|oauth_code)/i;

/**
 * Sanitiza objetos recursivamente substituindo valores de campos sensíveis por '[REDACTED]'.
 */
export function redactSensitiveData(data: unknown, seen = new WeakSet()): unknown {
  if (data === null || data === undefined) return data;
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
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      redacted[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      redacted[key] = redactSensitiveData(value, seen);
    } else {
      redacted[key] = value;
    }
  }

  return redacted;
}

/**
 * Padrões de segredo que podem aparecer embutidos em texto livre (mensagens de erro
 * externas, corpos de exceção de bibliotecas/providers) fora da estrutura chave/valor
 * que `redactSensitiveData` cobre. Cada padrão redige apenas o valor sensível.
 */
const INLINE_SECRET_PATTERNS: RegExp[] = [
  // Authorization: Bearer/Basic <token>
  /\b(Authorization\s*[:=]\s*(?:Bearer|Basic)\s+)([^\s,;]+)/gi,
  // Set-Cookie / cookie: <valor>
  /\b(Set-Cookie\s*[:=]\s*)([^\s,;]+)/gi,
  // key=value ou key: value onde a key bate no padrão de campo sensível
  /\b((?:password|secret|token|apiKey|api_key|client_secret|access_token|refresh_token|cvv|cpf|cnpj|oauth_state|oauth_code)\s*[:=]\s*)([^\s,;]+)/gi,
];

/**
 * Redige segredos embutidos em uma string livre (ex.: mensagem de `Error` de uma
 * biblioteca/provider externo que interpolou um header ou credencial no texto).
 * Não sanitiza o objeto/estrutura — usar `redactSensitiveData` para isso.
 */
export function redactSensitiveText(text: string): string {
  let result = text;
  for (const pattern of INLINE_SECRET_PATTERNS) {
    result = result.replace(pattern, (_match, prefix: string) => `${prefix}[REDACTED]`);
  }
  return result;
}

/**
 * Extrai de um valor lançado (Error ou não) apenas nome e mensagem redigida, para uso
 * seguro em log estruturado. Nunca inclui o stack trace cru, que pode conter caminhos de
 * arquivo, query strings ou payloads sensíveis interpolados por bibliotecas externas.
 */
export function sanitizeErrorForLog(err: unknown): { name: string; message: string } {
  if (err instanceof Error) {
    return {
      name: err.name || 'Error',
      message: redactSensitiveText(err.message),
    };
  }
  if (typeof err === 'string') {
    return { name: 'UnknownError', message: redactSensitiveText(err) };
  }
  return { name: 'UnknownError', message: 'Erro não identificado' };
}

/**
 * Emite uma linha de log estruturada no formato JSON.
 */
export function logStructured(level: LogLevel, message: string, context?: LogContext): void {
  const sanitizedContext = context ? (redactSensitiveData(context) as LogContext) : {};
  const payload = {
    timestamp: new Date().toISOString(),
    level,
    subsystem: context?.subsystem || 'app',
    message: redactSensitiveText(message),
    ...sanitizedContext,
  };

  const output = JSON.stringify(payload);

  if (level === 'error') {
    console.error(output);
  } else if (level === 'warn') {
    console.warn(output);
  } else if (level === 'info') {
    console.info(output);
  } else {
    console.debug(output);
  }
}

export const logger = {
  info: (message: string, context?: LogContext) => logStructured('info', message, context),
  warn: (message: string, context?: LogContext) => logStructured('warn', message, context),
  error: (message: string, context?: LogContext) => logStructured('error', message, context),
  debug: (message: string, context?: LogContext) => logStructured('debug', message, context),
};
