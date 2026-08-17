import { describe, expect, it, vi } from 'vitest';

import { exchangeBlingAuthorizationCode } from './blingOAuth';

describe('Bling OAuth token adapter', () => {
  it('sends the documented authorization-code request and parses tokens', async () => {
    const providerResponse = {
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      expires_in: 21_600,
    };
    const requests: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
    const fetchImplementation = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      requests.push({ input, init });
      return Response.json(providerResponse);
    });

    const result = await exchangeBlingAuthorizationCode(
      {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        code: 'authorization-code',
      },
      fetchImplementation,
    );

    expect(result).toEqual({ _tag: 'BlingOAuthTokenExchangeSucceeded', ...providerResponse });
    expect(fetchImplementation).toHaveBeenCalledOnce();
    const request = requests[0];
    if (!request?.init) {
      throw new Error('Bling OAuth request was not captured.');
    }
    const { input: url, init } = request;
    expect(url).toBe('https://api.bling.com.br/Api/v3/oauth/token');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      'Content-Type': 'application/x-www-form-urlencoded',
      'enable-jwt': '1',
    });
    if (!(init.body instanceof URLSearchParams)) {
      throw new Error('Bling OAuth request body has an unexpected type.');
    }
    expect(init.body.toString()).toBe(
      'grant_type=authorization_code&code=authorization-code',
    );
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('fails closed when Bling returns an incomplete token contract', async () => {
    const fetchImplementation = vi.fn(async () => Response.json({ access_token: '' }));

    await expect(exchangeBlingAuthorizationCode(
      { clientId: 'id', clientSecret: 'secret', code: 'code' },
      fetchImplementation,
    )).resolves.toEqual({
      _tag: 'BlingOAuthTokenExchangeFailed',
      reason: 'invalid-response',
    });
  });

  it('maps a provider deadline to a typed timeout', async () => {
    const fetchImplementation = vi.fn(async () => {
      throw new DOMException('Timed out', 'TimeoutError');
    });

    await expect(exchangeBlingAuthorizationCode(
      { clientId: 'id', clientSecret: 'secret', code: 'code' },
      fetchImplementation,
    )).resolves.toEqual({
      _tag: 'BlingOAuthTokenExchangeFailed',
      reason: 'timeout',
    });
  });
});
