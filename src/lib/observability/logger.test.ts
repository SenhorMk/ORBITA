import { describe, it, expect, vi } from 'vitest';
import { redactSensitiveData, logger } from './logger';

describe('logger & redaction boundary', () => {
  it('redactSensitiveData redige campos sensíveis como token, password, apiKey, secret', () => {
    const raw = {
      username: 'johndoe',
      password: 'supersecretpassword123',
      api_key: 'sk_live_12345',
      client_secret: 'oauth_secret_abc',
      nested: {
        access_token: 'bearer_token_xyz',
        cpf: '123.456.789-00',
        publicField: 'safeValue',
      },
    };

    const redacted = redactSensitiveData(raw) as Record<string, unknown>;

    expect(redacted.username).toBe('johndoe');
    expect(redacted.password).toBe('[REDACTED]');
    expect(redacted.api_key).toBe('[REDACTED]');
    expect(redacted.client_secret).toBe('[REDACTED]');

    const nested = redacted.nested as Record<string, unknown>;
    expect(nested.access_token).toBe('[REDACTED]');
    expect(nested.cpf).toBe('[REDACTED]');
    expect(nested.publicField).toBe('safeValue');
  });

  it('redactSensitiveData lida com arrays de objetos', () => {
    const list = [
      { token: 'secret1', id: 1 },
      { token: 'secret2', id: 2 },
    ];

    const redacted = redactSensitiveData(list) as Array<Record<string, unknown>>;
    expect(redacted[0].token).toBe('[REDACTED]');
    expect(redacted[0].id).toBe(1);
    expect(redacted[1].token).toBe('[REDACTED]');
  });

  it('logStructured formata payload JSON com subsystem e timestamp', () => {
    const spyInfo = vi.spyOn(console, 'info').mockImplementation(() => {});

    logger.info('User action performed', {
      subsystem: 'app',
      correlationId: 'corr_test_1',
      actorId: 'user_1',
      token: 'dontlogthis',
    });

    expect(spyInfo).toHaveBeenCalled();
    const logged = JSON.parse(spyInfo.mock.calls[0][0]);

    expect(logged.level).toBe('info');
    expect(logged.subsystem).toBe('app');
    expect(logged.message).toBe('User action performed');
    expect(logged.correlationId).toBe('corr_test_1');
    expect(logged.token).toBe('[REDACTED]');

    spyInfo.mockRestore();
  });
});
