import { describe, expect, it } from 'vitest';

import { checkRateLimit, normalizeIp, rateLimitDenialStatus, type RateLimitStorePort } from './rateLimit';

/** Deterministic in-memory fake implementing the real store port, not a module mock. */
function createFakeStore(): RateLimitStorePort & { readonly calls: string[] } {
  const rows = new Map<string, { count: number; windowStart: number }>();
  const calls: string[] = [];
  return {
    calls,
    async consume(key, limit, windowMs, now) {
      calls.push(key);
      const existing = rows.get(key);
      const windowExpired = !existing || now - existing.windowStart >= windowMs;
      const count = windowExpired ? 1 : existing.count + 1;
      const windowStart = windowExpired ? now : existing.windowStart;
      rows.set(key, { count, windowStart });
      return {
        _tag: 'RateLimitRecorded',
        allowed: count <= limit,
        count,
        resetAt: windowStart + windowMs,
      };
    },
  };
}

describe('rate limit decision boundary', () => {
  it('allows requests under the limit, then blocks once the limit is exceeded', async () => {
    const store = createFakeStore();
    const now = 1_700_000_000_000;

    const first = await checkRateLimit(store, 'register', '203.0.113.10', { limit: 2, windowMs: 60_000 }, now);
    const second = await checkRateLimit(store, 'register', '203.0.113.10', { limit: 2, windowMs: 60_000 }, now + 1_000);
    const third = await checkRateLimit(store, 'register', '203.0.113.10', { limit: 2, windowMs: 60_000 }, now + 2_000);

    expect(first).toEqual({ _tag: 'RateLimitAllowed', remaining: 1, resetAt: now + 60_000 });
    expect(second).toEqual({ _tag: 'RateLimitAllowed', remaining: 0, resetAt: now + 60_000 });
    expect(third._tag).toBe('RateLimitBlocked');
    expect(store.calls).toEqual(['register:203.0.113.10', 'register:203.0.113.10', 'register:203.0.113.10']);
  });

  it('resets the window once it elapses', async () => {
    const store = createFakeStore();
    const now = 1_700_000_000_000;

    await checkRateLimit(store, 'register', '203.0.113.10', { limit: 1, windowMs: 60_000 }, now);
    const blocked = await checkRateLimit(store, 'register', '203.0.113.10', { limit: 1, windowMs: 60_000 }, now + 1_000);
    const allowedAgain = await checkRateLimit(
      store,
      'register',
      '203.0.113.10',
      { limit: 1, windowMs: 60_000 },
      now + 60_001,
    );

    expect(blocked._tag).toBe('RateLimitBlocked');
    expect(allowedAgain._tag).toBe('RateLimitAllowed');
  });

  it('keeps separate identifiers isolated', async () => {
    const store = createFakeStore();
    const now = 1_700_000_000_000;

    await checkRateLimit(store, 'register', '203.0.113.10', { limit: 1, windowMs: 60_000 }, now);
    const otherIp = await checkRateLimit(store, 'register', '198.51.100.20', { limit: 1, windowMs: 60_000 }, now);

    expect(otherIp._tag).toBe('RateLimitAllowed');
  });

  it('fails closed when the store is unavailable, never allowing unlimited traffic', async () => {
    const failingStore: RateLimitStorePort = {
      async consume() {
        return { _tag: 'RateLimitStoreUnavailable', cause: 'connection-refused' };
      },
    };

    const result = await checkRateLimit(
      failingStore,
      'register',
      '203.0.113.10',
      { limit: 5, windowMs: 60_000 },
      1_700_000_000_000,
    );

    expect(result).toEqual({ _tag: 'RateLimitStoreUnavailable', cause: 'connection-refused' });
  });

  it('maps denial tags to safe HTTP statuses', () => {
    expect(rateLimitDenialStatus({ _tag: 'RateLimitBlocked', retryAfterMs: 1_000, resetAt: 0 })).toBe(429);
    expect(rateLimitDenialStatus({ _tag: 'RateLimitStoreUnavailable', cause: 'x' })).toBe(503);
  });

  it('normalizes the client IP from x-forwarded-for, taking the first hop and stripping port/whitespace', () => {
    const request = new Request('https://orbita.test/api/auth/register', {
      headers: { 'x-forwarded-for': ' 203.0.113.10 , 10.0.0.1' },
    });

    expect(normalizeIp(request)).toBe('203.0.113.10');
  });

  it('falls back to a fixed unknown-ip bucket when no forwarding header is present', () => {
    const request = new Request('https://orbita.test/api/auth/register');
    expect(normalizeIp(request)).toBe('unknown');
  });
});
