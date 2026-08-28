import { describe, it, expect, vi } from 'vitest';
import { redactSensitiveData, redactSensitiveText, logger, sanitizeErrorForLog } from './logger';

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

  it('redactSensitiveData redige state e code de fluxos OAuth', () => {
    const raw = {
      provider: 'bling',
      state: 'ab12cd34',
      code: 'auth-code-xyz',
      correlationId: 'corr_1',
    };

    const redacted = redactSensitiveData(raw) as Record<string, unknown>;

    expect(redacted.provider).toBe('bling');
    expect(redacted.state).toBe('[REDACTED]');
    expect(redacted.code).toBe('[REDACTED]');
    expect(redacted.correlationId).toBe('corr_1');
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

  it('redactSensitiveText redige um header Authorization embutido em texto livre', () => {
    const text = 'Falha upstream: Authorization: Bearer synthetic-opaque-token-abcdef1234567890 rejeitado pelo provider';
    const redacted = redactSensitiveText(text);
    expect(redacted).not.toContain('synthetic-opaque-token-abcdef1234567890');
    expect(redacted).toContain('[REDACTED]');
  });

  it('redactSensitiveText redige cookie e password embutidos em mensagem de erro externa', () => {
    const text = 'Set-Cookie: session=abc123xyz; password=hunter2plus rejected';
    const redacted = redactSensitiveText(text);
    expect(redacted).not.toContain('abc123xyz');
    expect(redacted).not.toContain('hunter2plus');
  });

  it('redactSensitiveText preserva texto sem segredos inalterado', () => {
    const text = 'Timeout ao conectar ao provider Bling após 3 tentativas';
    expect(redactSensitiveText(text)).toBe(text);
  });

  it('logStructured sanitiza a mensagem quando ela contém um segredo vazado de um erro externo', () => {
    const spyError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const externalError = new Error('upstream rejected token=synthetic-opaque-zzz999888777 during handshake');
    logger.error(externalError.message, { subsystem: 'provider', correlationId: 'corr_err_1' });

    const logged = JSON.parse(spyError.mock.calls[0][0]);
    expect(logged.message).not.toContain('synthetic-opaque-zzz999888777');
    expect(logged.message).toContain('[REDACTED]');

    spyError.mockRestore();
  });

  it('sanitizeErrorForLog extrai apenas nome e mensagem redigida, descartando stack cru', () => {
    const err = new Error('failed with password=supersecret123 in payload');
    err.name = 'UpstreamError';

    const safe = sanitizeErrorForLog(err);

    expect(safe.name).toBe('UpstreamError');
    expect(safe.message).not.toContain('supersecret123');
    expect(safe.message).toContain('[REDACTED]');
    expect(safe).not.toHaveProperty('stack');
  });

  it('sanitizeErrorForLog lida com valores não-Error (string/objeto lançado) sem lançar', () => {
    expect(sanitizeErrorForLog('plain string error with token=abc123deadbeef')).toEqual({
      name: 'UnknownError',
      message: expect.stringContaining('[REDACTED]'),
    });
    expect(sanitizeErrorForLog({ weird: true })).toEqual({
      name: 'UnknownError',
      message: 'Erro não identificado',
    });
  });
});
