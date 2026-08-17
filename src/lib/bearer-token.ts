/** Result of reading an access token from an HTTP Authorization header. */
export type BearerTokenReadResult =
  | { readonly _tag: 'BearerTokenFound'; readonly token: string }
  | { readonly _tag: 'BearerTokenMissing' }
  | { readonly _tag: 'DevelopmentTokenRejected' };

const rejectedDevelopmentTokens = new Set([
  'mock-dono',
  'mock-colaborador',
  'dev-fallback',
]);

/**
 * Read a bearer token exclusively from the Authorization header.
 *
 * Query-string tokens are intentionally ignored because URLs commonly leak
 * through browser history, referrers, analytics, proxies, and access logs.
 *
 * @param request - Incoming HTTP request at the authentication boundary.
 * @returns A tagged result describing whether a usable token was found.
 */
export function readBearerToken(request: Request): BearerTokenReadResult {
  const authorization = request.headers.get('Authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  const token = match?.[1]?.trim() ?? '';

  if (!token) {
    return { _tag: 'BearerTokenMissing' };
  }

  if (rejectedDevelopmentTokens.has(token)) {
    return { _tag: 'DevelopmentTokenRejected' };
  }

  return { _tag: 'BearerTokenFound', token };
}
