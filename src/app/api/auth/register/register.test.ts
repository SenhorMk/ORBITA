import { describe, expect, it } from 'vitest';

import { createRegisterHandler, type RegisterDependencies, type RegisterSignUpResult } from './route';
import type { RateLimitStorePort } from '../../../../lib/rateLimit';

function alwaysAllowRateLimit(): RateLimitStorePort {
  return { async consume() { return { _tag: 'RateLimitRecorded', allowed: true, count: 1, resetAt: Date.now() + 60_000 }; } };
}

function countingRateLimit(limit: number): RateLimitStorePort & { calls: number } {
  let count = 0;
  return {
    get calls() { return count; },
    async consume() {
      count += 1;
      return { _tag: 'RateLimitRecorded', allowed: count <= limit, count, resetAt: Date.now() + 60_000 };
    },
  };
}

function baseDeps(overrides: Partial<RegisterDependencies> = {}): RegisterDependencies {
  return {
    rateLimitStore: alwaysAllowRateLimit(),
    signUp: async () => ({ _tag: 'SignUpSucceeded' }),
    ...overrides,
  };
}

function request(body: unknown): Request {
  return new Request('https://orbita.test/api/auth/register', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

describe('POST /api/auth/register', () => {
  it('rejects registration request when required fields are missing', async () => {
    const handler = createRegisterHandler(baseDeps());
    const response = await handler(request({ email: 'user@orbita.test' }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ success: false, error: 'E-mail, senha e nome são obrigatórios.' });
  });

  it('rejects registration request when password is shorter than 6 characters', async () => {
    const handler = createRegisterHandler(baseDeps());
    const response = await handler(request({ email: 'user@orbita.test', password: '123', name: 'User Test' }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ success: false, error: 'A senha deve ter pelo menos 6 caracteres.' });
  });

  it('rejects registration request with a malformed e-mail', async () => {
    const handler = createRegisterHandler(baseDeps());
    const response = await handler(request({ email: 'not-an-email', password: 'validpass123', name: 'User Test' }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ success: false, error: 'E-mail inválido.' });
  });

  it('returns the exact same public response for a brand-new registration and an already-registered e-mail', async () => {
    const succeeded: RegisterSignUpResult = { _tag: 'SignUpSucceeded' };
    const alreadyRegistered: RegisterSignUpResult = { _tag: 'SignUpAlreadyRegistered' };

    const newHandler = createRegisterHandler(baseDeps({ signUp: async () => succeeded }));
    const duplicateHandler = createRegisterHandler(baseDeps({ signUp: async () => alreadyRegistered }));

    const newResponse = await newHandler(request({ email: 'new@orbita.test', password: 'validpass123', name: 'New User' }));
    const duplicateResponse = await duplicateHandler(request({ email: 'existing@orbita.test', password: 'validpass123', name: 'Existing User' }));

    expect(newResponse.status).toBe(duplicateResponse.status);
    expect(await newResponse.json()).toEqual(await duplicateResponse.json());
    expect(newResponse.status).toBe(200);
  });

  it('never includes user data in the public registration response', async () => {
    const handler = createRegisterHandler(baseDeps({ signUp: async () => ({ _tag: 'SignUpSucceeded' }) }));
    const response = await handler(request({ email: 'new@orbita.test', password: 'validpass123', name: 'New User' }));
    const json = await response.json() as Record<string, unknown>;

    expect(json.user).toBeUndefined();
    expect(JSON.stringify(json)).not.toContain('new@orbita.test');
  });

  it('returns a generic 500 (not an enumeration signal) when the identity provider fails unexpectedly', async () => {
    const handler = createRegisterHandler(baseDeps({ signUp: async () => ({ _tag: 'SignUpFailed', cause: 'provider_down' }) }));
    const response = await handler(request({ email: 'user@orbita.test', password: 'validpass123', name: 'User Test' }));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ success: false, error: 'Erro ao criar conta. Tente novamente mais tarde.' });
  });

  it('blocks registration attempts once the rate limit is exceeded, without calling the identity provider', async () => {
    const rateLimitStore = countingRateLimit(2);
    let signUpCalls = 0;
    const handler = createRegisterHandler(baseDeps({
      rateLimitStore,
      signUp: async () => { signUpCalls += 1; return { _tag: 'SignUpSucceeded' }; },
    }));
    const body = { email: 'user@orbita.test', password: 'validpass123', name: 'User Test' };

    const first = await handler(request(body));
    const second = await handler(request(body));
    const third = await handler(request(body));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(429);
    expect(signUpCalls).toBe(2);
  });

  it('fails closed with 503 when the rate limit store is unavailable, never allowing unlimited registration', async () => {
    let signUpCalls = 0;
    const handler = createRegisterHandler(baseDeps({
      rateLimitStore: { async consume() { return { _tag: 'RateLimitStoreUnavailable', cause: 'connection-refused' }; } },
      signUp: async () => { signUpCalls += 1; return { _tag: 'SignUpSucceeded' }; },
    }));

    const response = await handler(request({ email: 'user@orbita.test', password: 'validpass123', name: 'User Test' }));

    expect(response.status).toBe(503);
    expect(signUpCalls).toBe(0);
  });

  it('rejects a request with an invalid JSON body', async () => {
    const handler = createRegisterHandler(baseDeps());
    const malformedRequest = new Request('https://orbita.test/api/auth/register', {
      method: 'POST',
      body: '{not-json',
    });

    const response = await handler(malformedRequest);
    expect(response.status).toBe(400);
  });
});
