import { z } from 'zod';

const BLING_OAUTH_TOKEN_URL =
  process.env.BLING_OAUTH_TOKEN_URL || 'https://api.bling.com.br/Api/v3/oauth/token';
const BLING_OAUTH_TIMEOUT_MS = 10_000;

const BlingTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().int().positive().max(2_592_000),
});

type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/** Credentials and one-time code required by the Bling token endpoint. */
export type BlingAuthorizationCodeInput = {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly code: string;
};

/** Credentials and refresh token required for rotating Bling tokens. */
export type BlingRefreshTokenInput = {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
};

/** Typed outcome of exchanging or refreshing a Bling OAuth token. */
export type BlingOAuthTokenExchangeResult =
  | {
      readonly _tag: 'BlingOAuthTokenExchangeSucceeded';
      readonly access_token: string;
      readonly refresh_token: string;
      readonly expires_in: number;
    }
  | {
      readonly _tag: 'BlingOAuthTokenExchangeFailed';
      readonly reason: 'http' | 'invalid-response' | 'network' | 'rate-limited' | 'timeout';
      readonly status?: number;
      readonly retryAfterSeconds?: number;
    };

async function executeBlingTokenRequest(
  clientId: string,
  clientSecret: string,
  params: Record<string, string>,
  fetchImplementation: FetchImplementation = fetch,
): Promise<BlingOAuthTokenExchangeResult> {
  const credentials = Buffer.from(
    `${clientId}:${clientSecret}`,
    'utf8',
  ).toString('base64');

  let response: Response;
  try {
    response = await fetchImplementation(BLING_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'enable-jwt': '1',
      },
      body: new URLSearchParams(params),
      signal: AbortSignal.timeout(BLING_OAUTH_TIMEOUT_MS),
    });
  } catch (error: unknown) {
    const isTimeout = error instanceof DOMException
      && (error.name === 'AbortError' || error.name === 'TimeoutError');
    return {
      _tag: 'BlingOAuthTokenExchangeFailed',
      reason: isTimeout ? 'timeout' : 'network',
    };
  }

  if (response.status === 429) {
    const retryHeader = response.headers?.get('Retry-After');
    const retryAfter = retryHeader ? Number.parseInt(retryHeader, 10) : undefined;
    return {
      _tag: 'BlingOAuthTokenExchangeFailed',
      reason: 'rate-limited',
      status: 429,
      retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : 60,
    };
  }

  if (!response.ok) {
    return {
      _tag: 'BlingOAuthTokenExchangeFailed',
      reason: 'http',
      status: response.status,
    };
  }

  try {
    const payload: unknown = await response.json();
    const parsed = BlingTokenResponseSchema.safeParse(payload);
    if (!parsed.success) {
      return {
        _tag: 'BlingOAuthTokenExchangeFailed',
        reason: 'invalid-response',
      };
    }

    return { _tag: 'BlingOAuthTokenExchangeSucceeded', ...parsed.data };
  } catch {
    return {
      _tag: 'BlingOAuthTokenExchangeFailed',
      reason: 'invalid-response',
    };
  }
}

/** Exchange a one-time code without retries and with a bounded provider deadline. */
export async function exchangeBlingAuthorizationCode(
  input: BlingAuthorizationCodeInput,
  fetchImplementation: FetchImplementation = fetch,
): Promise<BlingOAuthTokenExchangeResult> {
  return executeBlingTokenRequest(
    input.clientId,
    input.clientSecret,
    {
      grant_type: 'authorization_code',
      code: input.code,
    },
    fetchImplementation,
  );
}

/** Refresh an existing Bling access token using its refresh token. */
export async function refreshBlingToken(
  input: BlingRefreshTokenInput,
  fetchImplementation: FetchImplementation = fetch,
): Promise<BlingOAuthTokenExchangeResult> {
  return executeBlingTokenRequest(
    input.clientId,
    input.clientSecret,
    {
      grant_type: 'refresh_token',
      refresh_token: input.refreshToken,
    },
    fetchImplementation,
  );
}
