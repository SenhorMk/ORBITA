import { beforeAll, describe, expect, it } from 'vitest';

describe('Auth Register Boundary', () => {
  beforeAll(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project-ref.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'public-key-12345678901234567890';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'server-key-12345678901234567890';
  });

  it('rejects registration request when required fields are missing', async () => {
    const { POST: registerHandler } = await import('./route');
    const request = new Request('https://orbita.test/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email: 'user@orbita.test' }),
    });

    const response = await registerHandler(request);
    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json).toEqual({
      success: false,
      error: 'E-mail, senha e nome são obrigatórios.',
    });
  });

  it('rejects registration request when password is shorter than 6 characters', async () => {
    const { POST: registerHandler } = await import('./route');
    const request = new Request('https://orbita.test/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        email: 'user@orbita.test',
        password: '123',
        name: 'User Test',
      }),
    });

    const response = await registerHandler(request);
    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json).toEqual({
      success: false,
      error: 'A senha deve ter pelo menos 6 caracteres.',
    });
  });
});
