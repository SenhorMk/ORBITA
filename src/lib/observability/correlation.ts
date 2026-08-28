import crypto from 'crypto';

export const CORRELATION_HEADER = 'x-correlation-id';
export const REQUEST_ID_HEADER = 'x-request-id';

/** Tamanho máximo aceito para um correlation id vindo de um header não confiável. */
const MAX_SAFE_CORRELATION_ID_LENGTH = 128;

/** Alfabeto seguro para correlation id: alfanumérico, hífen, underscore e ponto. */
const SAFE_CORRELATION_ID_PATTERN = /^[A-Za-z0-9_.-]+$/;

/**
 * Verifica se um valor de header é seguro para ser reutilizado como correlation id:
 * tamanho limitado e apenas caracteres do alfabeto seguro (sem espaços, controle,
 * HTML ou separadores que possibilitem injeção de log/header).
 */
export function isSafeCorrelationId(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_SAFE_CORRELATION_ID_LENGTH &&
    SAFE_CORRELATION_ID_PATTERN.test(value)
  );
}

/**
 * Gera um novo Correlation ID único e seguro.
 */
export function generateCorrelationId(): string {
  return `corr_${crypto.randomUUID()}`;
}

/**
 * Extrai o Correlation ID de uma Request ou Headers HTTP.
 * Se não existir, gera um novo automaticamente.
 */
export function getCorrelationId(input?: Request | Headers | HeadersInit): string {
  if (!input) {
    return generateCorrelationId();
  }

  let headers: Headers;
  if (input instanceof Request) {
    headers = input.headers;
  } else if (input instanceof Headers) {
    headers = input;
  } else {
    headers = new Headers(input);
  }

  const existing =
    headers.get(CORRELATION_HEADER) ||
    headers.get(REQUEST_ID_HEADER) ||
    headers.get('traceparent');

  const trimmed = existing ? existing.trim() : '';
  return trimmed.length > 0 && isSafeCorrelationId(trimmed) ? trimmed : generateCorrelationId();
}

/**
 * Retorna os headers propagando o Correlation ID para chamadas subsequentes.
 */
export function withCorrelationHeaders(
  baseHeaders?: HeadersInit,
  correlationId?: string,
): Record<string, string> {
  const cid = correlationId || generateCorrelationId();
  const merged: Record<string, string> = {};

  if (baseHeaders) {
    if (baseHeaders instanceof Headers) {
      baseHeaders.forEach((value, key) => {
        merged[key.toLowerCase()] = value;
      });
    } else if (Array.isArray(baseHeaders)) {
      for (const [key, value] of baseHeaders) {
        merged[key.toLowerCase()] = value;
      }
    } else {
      for (const [key, value] of Object.entries(baseHeaders)) {
        if (value !== undefined) {
          merged[key.toLowerCase()] = String(value);
        }
      }
    }
  }

  merged[CORRELATION_HEADER] = cid;
  merged[REQUEST_ID_HEADER] = cid;
  return merged;
}
