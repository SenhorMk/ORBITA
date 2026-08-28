import { describe, expect, it } from 'vitest';
import { buildAllowlistedReturnUrl, parseStripeRuntimeConfig, resolvePriceId, type StripeConfigEnv } from './stripeConfig';

const VALID_ENV = {
  STRIPE_SECRET_KEY: 'ci-test-secret-key-1234567890abcdefghij',
  STRIPE_WEBHOOK_SECRET: 'ci-test-webhook-secret-1234567890abcdefghij',
  STRIPE_APP_BASE_URL: 'https://app.example.com',
  STRIPE_PRICE_PRO_MONTHLY: 'price_pro_monthly_123',
  STRIPE_PRICE_PRO_YEARLY: 'price_pro_yearly_123',
  STRIPE_PRICE_ENTERPRISE_MONTHLY: 'price_enterprise_monthly_123',
  STRIPE_PRICE_ENTERPRISE_YEARLY: 'price_enterprise_yearly_123',
  STRIPE_CHECKOUT_ENABLED: 'true',
} satisfies StripeConfigEnv;

describe('parseStripeRuntimeConfig', () => {
  it('accepts a fully configured, non-placeholder environment', () => {
    const result = parseStripeRuntimeConfig(VALID_ENV);
    expect(result._tag).toBe('StripeConfigValid');
  });

  it('rejects a missing STRIPE_SECRET_KEY', () => {
    const result = parseStripeRuntimeConfig({ ...VALID_ENV, STRIPE_SECRET_KEY: '' });
    expect(result._tag).toBe('StripeConfigInvalid');
    if (result._tag === 'StripeConfigInvalid') {
      expect(result.issues.some((i) => i.includes('STRIPE_SECRET_KEY'))).toBe(true);
    }
  });

  it('rejects a placeholder STRIPE_SECRET_KEY', () => {
    const result = parseStripeRuntimeConfig({
      ...VALID_ENV,
      STRIPE_SECRET_KEY: 'your-placeholder-secret-not-real-1234567890',
    });
    expect(result._tag).toBe('StripeConfigInvalid');
  });

  it('rejects a placeholder STRIPE_WEBHOOK_SECRET', () => {
    const result = parseStripeRuntimeConfig({ ...VALID_ENV, STRIPE_WEBHOOK_SECRET: 'your-webhook-secret-here' });
    expect(result._tag).toBe('StripeConfigInvalid');
  });

  it('rejects a Price ID missing the price_ prefix', () => {
    const result = parseStripeRuntimeConfig({ ...VALID_ENV, STRIPE_PRICE_PRO_MONTHLY: 'not-a-price-id' });
    expect(result._tag).toBe('StripeConfigInvalid');
  });

  it('rejects a placeholder Price ID', () => {
    const result = parseStripeRuntimeConfig({
      ...VALID_ENV,
      STRIPE_PRICE_ENTERPRISE_YEARLY: 'price_replace-me_yearly',
    });
    expect(result._tag).toBe('StripeConfigInvalid');
  });

  it('rejects a non-URL STRIPE_APP_BASE_URL', () => {
    const result = parseStripeRuntimeConfig({ ...VALID_ENV, STRIPE_APP_BASE_URL: 'not-a-url' });
    expect(result._tag).toBe('StripeConfigInvalid');
  });

  it('defaults checkoutEnabled to false when unset', () => {
    const env = { ...VALID_ENV };
    delete (env as Record<string, string | undefined>).STRIPE_CHECKOUT_ENABLED;
    const result = parseStripeRuntimeConfig(env);
    expect(result._tag).toBe('StripeConfigValid');
    if (result._tag === 'StripeConfigValid') {
      expect(result.config.checkoutEnabled).toBe(false);
    }
  });
});

describe('resolvePriceId', () => {
  it('resolves the allowlisted price id for a plan + interval combination', () => {
    const parsed = parseStripeRuntimeConfig(VALID_ENV);
    if (parsed._tag !== 'StripeConfigValid') throw new Error('unexpected invalid config');
    expect(resolvePriceId(parsed.config, 'pro', 'monthly')).toBe('price_pro_monthly_123');
    expect(resolvePriceId(parsed.config, 'enterprise', 'yearly')).toBe('price_enterprise_yearly_123');
  });
});

describe('buildAllowlistedReturnUrl', () => {
  it('builds an absolute URL from the configured base origin and a relative path', () => {
    const parsed = parseStripeRuntimeConfig(VALID_ENV);
    if (parsed._tag !== 'StripeConfigValid') throw new Error('unexpected invalid config');
    const url = buildAllowlistedReturnUrl(parsed.config, '/faturamento?ok=1');
    expect(url).toBe('https://app.example.com/faturamento?ok=1');
  });

  it('throws SAFETY when a client-controlled value tries to escape the allowlisted origin', () => {
    const parsed = parseStripeRuntimeConfig(VALID_ENV);
    if (parsed._tag !== 'StripeConfigValid') throw new Error('unexpected invalid config');
    expect(() => buildAllowlistedReturnUrl(parsed.config, 'https://evil.example.com/steal')).toThrow(/SAFETY/);
    expect(() => buildAllowlistedReturnUrl(parsed.config, '//evil.example.com/steal')).toThrow(/SAFETY/);
  });
});
