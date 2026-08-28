import { describe, expect, it } from 'vitest';
import {
  generateVerificationCode,
  hashVerificationCode,
  verifyClienteFinalChallenge,
  verifyLojistaSession,
} from './titularVerificationService';

describe('verifyLojistaSession', () => {
  it('verifies an authenticated user requesting about themselves (owner autorizado)', () => {
    const result = verifyLojistaSession({
      authenticatedActorId: 'user-1',
      titularRefUserId: 'user-1',
    });
    expect(result).toEqual({ _tag: 'Verified', verifiedBy: 'user-1' });
  });

  it('rejects an authenticated user requesting about someone else (impersonation)', () => {
    const result = verifyLojistaSession({
      authenticatedActorId: 'user-2',
      titularRefUserId: 'user-1',
    });
    expect(result).toEqual({ _tag: 'Impersonation' });
  });

  it('rejects a missing/empty session', () => {
    expect(verifyLojistaSession({ authenticatedActorId: null, titularRefUserId: 'user-1' })).toEqual({
      _tag: 'SessionInvalid',
    });
    expect(verifyLojistaSession({ authenticatedActorId: '  ', titularRefUserId: 'user-1' })).toEqual({
      _tag: 'SessionInvalid',
    });
  });
});

describe('verifyClienteFinalChallenge', () => {
  const now = new Date('2026-01-01T12:00:00Z');
  const expiresAt = new Date('2026-01-01T12:30:00Z');
  const code = '482913';
  const storedCodeHash = hashVerificationCode(code);

  it('rejects a request with only email/document and no code at all (nunca só e-mail)', () => {
    const result = verifyClienteFinalChallenge({
      submittedCode: null,
      storedCodeHash,
      expiresAt,
      now,
      attemptsSoFar: 0,
      maxAttempts: 5,
    });
    expect(result).toEqual({ _tag: 'CodeMissing' });
  });

  it('rejects an empty-string code the same way', () => {
    const result = verifyClienteFinalChallenge({
      submittedCode: '   ',
      storedCodeHash,
      expiresAt,
      now,
      attemptsSoFar: 0,
      maxAttempts: 5,
    });
    expect(result).toEqual({ _tag: 'CodeMissing' });
  });

  it('rejects an impostor guessing the wrong code', () => {
    const result = verifyClienteFinalChallenge({
      submittedCode: '000000',
      storedCodeHash,
      expiresAt,
      now,
      attemptsSoFar: 0,
      maxAttempts: 5,
    });
    expect(result).toEqual({ _tag: 'CodeMismatch' });
  });

  it('accepts the correct code within the window and attempt budget', () => {
    const result = verifyClienteFinalChallenge({
      submittedCode: code,
      storedCodeHash,
      expiresAt,
      now,
      attemptsSoFar: 0,
      maxAttempts: 5,
    });
    expect(result).toEqual({ _tag: 'Verified' });
  });

  it('rejects a correct code submitted after expiration', () => {
    const result = verifyClienteFinalChallenge({
      submittedCode: code,
      storedCodeHash,
      expiresAt,
      now: new Date('2026-01-01T13:00:00Z'), // 30min after expiresAt
      attemptsSoFar: 0,
      maxAttempts: 5,
    });
    expect(result).toEqual({ _tag: 'ChallengeExpired' });
  });

  it('rejects once the attempt budget is exhausted, even with the right code', () => {
    const result = verifyClienteFinalChallenge({
      submittedCode: code,
      storedCodeHash,
      expiresAt,
      now,
      attemptsSoFar: 5,
      maxAttempts: 5,
    });
    expect(result).toEqual({ _tag: 'AttemptsExceeded' });
  });
});

describe('generateVerificationCode / hashVerificationCode', () => {
  it('generates a 6-digit numeric code', () => {
    const code = generateVerificationCode();
    expect(code).toMatch(/^\d{6}$/);
  });

  it('hashes deterministically and never returns the plaintext', () => {
    const hash1 = hashVerificationCode('123456');
    const hash2 = hashVerificationCode('123456');
    expect(hash1).toBe(hash2);
    expect(hash1).not.toContain('123456');
    expect(hash1).toMatch(/^[0-9a-f]{64}$/);
  });
});
