import { afterEach, describe, expect, it, vi } from 'vitest';

const originalEncryptionKey = process.env.ENCRYPTION_KEY;

afterEach(() => {
  if (originalEncryptionKey === undefined) {
    delete process.env.ENCRYPTION_KEY;
  } else {
    process.env.ENCRYPTION_KEY = originalEncryptionKey;
  }
  vi.resetModules();
});

describe('crypto configuration boundary', () => {
  it('reports a missing runtime key without exposing a value', async () => {
    delete process.env.ENCRYPTION_KEY;
    vi.resetModules();
    const { checkEncryptionConfiguration } = await import('./crypto');

    expect(checkEncryptionConfiguration()).toEqual({
      _tag: 'InvalidEncryptionConfiguration',
      reason: 'missing',
    });
  });

  it('reports an invalid runtime key format', async () => {
    process.env.ENCRYPTION_KEY = 'not-a-valid-key';
    vi.resetModules();
    const { checkEncryptionConfiguration } = await import('./crypto');

    expect(checkEncryptionConfiguration()).toEqual({
      _tag: 'InvalidEncryptionConfiguration',
      reason: 'invalid-format',
    });
  });

  it('can be imported without a key and fails only when encryption is requested', async () => {
    delete process.env.ENCRYPTION_KEY;
    vi.resetModules();

    const { encrypt } = await import('./crypto');

    expect(() => encrypt('sensitive value')).toThrowError(
      'Variável ENCRYPTION_KEY é obrigatória para criptografia.',
    );
  });

  it('round-trips a value with a valid key', async () => {
    process.env.ENCRYPTION_KEY = 'ab'.repeat(32);
    vi.resetModules();
    const { decrypt, encrypt } = await import('./crypto');

    const encrypted = encrypt('provider-token');

    expect(encrypted).not.toBe('provider-token');
    expect(decrypt(encrypted)).toBe('provider-token');
  });

  it('fails closed when an authenticated envelope is tampered with', async () => {
    process.env.ENCRYPTION_KEY = 'ab'.repeat(32);
    vi.resetModules();
    const { decrypt, encrypt } = await import('./crypto');
    const encrypted = encrypt('provider-token');
    if (!encrypted) {
      throw new Error('Encryption unexpectedly returned no envelope.');
    }
    const tampered = `${encrypted.slice(0, -1)}${encrypted.endsWith('0') ? '1' : '0'}`;

    expect(decrypt(tampered)).toBeNull();
  });

  it('fails closed for a malformed encrypted envelope', async () => {
    process.env.ENCRYPTION_KEY = 'ab'.repeat(32);
    vi.resetModules();
    const { decrypt } = await import('./crypto');

    expect(decrypt('invalid:encrypted-envelope')).toBeNull();
  });
});
