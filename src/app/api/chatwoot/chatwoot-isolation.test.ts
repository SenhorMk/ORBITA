import { beforeAll, describe, expect, it } from 'vitest';

describe('Chatwoot API boundary containment', () => {
  beforeAll(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project-ref.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'public-key-12345678901234567890';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'server-key-12345678901234567890';
  });

  it('denies unauthenticated requests on send route', async () => {
    const { POST: sendHandler } = await import('./send/route');
    const request = new Request('https://orbita.test/api/chatwoot/send', {
      method: 'POST',
      body: JSON.stringify({ conversationId: 100, content: 'Hello' }),
    });

    const response = await sendHandler(request);
    expect(response.status).toBe(401);
    const json = await response.json();
    expect(json).toEqual({ success: false, error: 'Não autorizado' });
  });

  it('denies unauthenticated requests on status route', async () => {
    const { POST: statusHandler } = await import('./status/route');
    const request = new Request('https://orbita.test/api/chatwoot/status', {
      method: 'POST',
      body: JSON.stringify({ conversationId: 100, status: 'resolved' }),
    });

    const response = await statusHandler(request);
    expect(response.status).toBe(401);
    const json = await response.json();
    expect(json).toEqual({ success: false, error: 'Não autorizado' });
  });

  it('denies unauthenticated requests on sync route', async () => {
    const { POST: syncHandler } = await import('./sync/route');
    const request = new Request('https://orbita.test/api/chatwoot/sync', {
      method: 'POST',
    });

    const response = await syncHandler(request);
    expect(response.status).toBe(401);
    const json = await response.json();
    expect(json).toEqual({ success: false, error: 'Não autorizado' });
  });
});
