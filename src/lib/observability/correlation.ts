import crypto from 'crypto';

export const CORRELATION_HEADER = 'x-correlation-id';
export const REQUEST_ID_HEADER = 'x-request-id';

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

  return existing && existing.trim().length > 0 ? existing.trim() : generateCorrelationId();
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
