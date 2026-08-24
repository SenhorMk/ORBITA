import { describe, expect, it, vi } from 'vitest';

import {
  exchangeBlingAuthorizationCode,
  refreshBlingToken,
} from './blingOAuth';

describe('Bling OAuth & Token Lifecycle Contract', () => {
  describe('exchangeBlingAuthorizationCode', () => {
    it('sends the documented authorization-code request and parses tokens on success', async () => {
      const providerResponse = {
        access_token: 'access-token-123',
        refresh_token: 'refresh-token-456',
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
        Authorization: 'Basic Y2xpZW50LWlkOmNsaWVudC1zZWNyZXQ=',
        'enable-jwt': '1',
      });
    });

    it('maps HTTP errors from the Bling OAuth endpoint', async () => {
      const fetchImplementation = vi.fn(async () =>
        new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
      );

      const result = await exchangeBlingAuthorizationCode(
        {
          clientId: 'client-id',
          clientSecret: 'client-secret',
          code: 'expired-code',
        },
        fetchImplementation,
      );

      expect(result).toEqual({
        _tag: 'BlingOAuthTokenExchangeFailed',
        reason: 'http',
        status: 400,
      });
    });

    it('handles HTTP 429 Rate Limiting with Retry-After header', async () => {
      const fetchImplementation = vi.fn(async () =>
        new Response(JSON.stringify({ error: 'rate_limit_exceeded' }), {
          status: 429,
          headers: { 'Retry-After': '120' },
        }),
      );

      const result = await exchangeBlingAuthorizationCode(
        {
          clientId: 'client-id',
          clientSecret: 'client-secret',
          code: 'code-123',
        },
        fetchImplementation,
      );

      expect(result).toEqual({
        _tag: 'BlingOAuthTokenExchangeFailed',
        reason: 'rate-limited',
        status: 429,
        retryAfterSeconds: 120,
      });
    });

    it('maps network abort / timeout cleanly', async () => {
      const fetchImplementation = vi.fn(async () => {
        throw new DOMException('The operation timed out.', 'TimeoutError');
      });

      const result = await exchangeBlingAuthorizationCode(
        {
          clientId: 'client-id',
          clientSecret: 'client-secret',
          code: 'code-123',
        },
        fetchImplementation,
      );

      expect(result).toEqual({
        _tag: 'BlingOAuthTokenExchangeFailed',
        reason: 'timeout',
      });
    });

    it('maps invalid or malformed provider response', async () => {
      const fetchImplementation = vi.fn(async () =>
        new Response('not-valid-json', { status: 200 }),
      );

      const result = await exchangeBlingAuthorizationCode(
        {
          clientId: 'client-id',
          clientSecret: 'client-secret',
          code: 'code-123',
        },
        fetchImplementation,
      );

      expect(result).toEqual({
        _tag: 'BlingOAuthTokenExchangeFailed',
        reason: 'invalid-response',
      });
    });
  });

  describe('refreshBlingToken', () => {
    it('successfully refreshes token with refresh_token grant type', async () => {
      const refreshResponse = {
        access_token: 'new-access-token-999',
        refresh_token: 'new-refresh-token-888',
        expires_in: 21_600,
      };
      const requests: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
      const fetchImplementation = vi.fn(async (
        input: string | URL | Request,
        init?: RequestInit,
      ) => {
        requests.push({ input, init });
        return Response.json(refreshResponse);
      });

      const result = await refreshBlingToken(
        {
          clientId: 'client-id',
          clientSecret: 'client-secret',
          refreshToken: 'valid-refresh-token',
        },
        fetchImplementation,
      );

      expect(result).toEqual({ _tag: 'BlingOAuthTokenExchangeSucceeded', ...refreshResponse });
      expect(fetchImplementation).toHaveBeenCalledOnce();
      const request = requests[0];
      if (!request?.init) {
        throw new Error('Refresh request was not captured.');
      }
      expect(request.init.body?.toString()).toContain('grant_type=refresh_token');
      expect(request.init.body?.toString()).toContain('refresh_token=valid-refresh-token');
    });

    it('maps token expiration / invalid_grant failure on refresh', async () => {
      const fetchImplementation = vi.fn(async () =>
        new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 401 }),
      );

      const result = await refreshBlingToken(
        {
          clientId: 'client-id',
          clientSecret: 'client-secret',
          refreshToken: 'expired-refresh-token',
        },
        fetchImplementation,
      );

      expect(result).toEqual({
        _tag: 'BlingOAuthTokenExchangeFailed',
        reason: 'http',
        status: 401,
      });
    });

    it('maps rate limiting during token refresh', async () => {
      const fetchImplementation = vi.fn(async () =>
        new Response(JSON.stringify({ error: 'too_many_requests' }), {
          status: 429,
          headers: { 'Retry-After': '45' },
        }),
      );

      const result = await refreshBlingToken(
        {
          clientId: 'client-id',
          clientSecret: 'client-secret',
          refreshToken: 'rt-123',
        },
        fetchImplementation,
      );

      expect(result).toEqual({
        _tag: 'BlingOAuthTokenExchangeFailed',
        reason: 'rate-limited',
        status: 429,
        retryAfterSeconds: 45,
      });
    });
  });
});
