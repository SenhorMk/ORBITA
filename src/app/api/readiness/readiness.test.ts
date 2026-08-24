import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/supabaseServer', () => ({
  supabaseServer: {
    from: vi.fn(),
  },
}));

describe('Readiness & Liveness Probes', () => {
  it('GET /api/readiness retorna 200 e status ready quando o banco está saudável', async () => {
    const { supabaseServer } = await import('@/lib/supabaseServer');
    const limitMock = vi.fn().mockResolvedValue({ data: [{ id: 'org-1' }], error: null });
    const selectMock = vi.fn().mockReturnValue({ limit: limitMock });
    const fromMock = supabaseServer.from as unknown as ReturnType<typeof vi.fn>;
    fromMock.mockReturnValue({ select: selectMock });

    const { GET: readinessHandler } = await import('./route');
    const req = new NextRequest('https://orbita.test/api/readiness');
    const res = await readinessHandler(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ready');
    expect(body.checks.database).toBe('ok');
    expect(res.headers.get('x-correlation-id')).toBeDefined();
  });

  it('GET /api/readiness retorna 503 quando o banco falha', async () => {
    const { supabaseServer } = await import('@/lib/supabaseServer');
    const limitMock = vi.fn().mockResolvedValue({ data: null, error: { message: 'Connection refused' } });
    const selectMock = vi.fn().mockReturnValue({ limit: limitMock });
    const fromMock = supabaseServer.from as unknown as ReturnType<typeof vi.fn>;
    fromMock.mockReturnValue({ select: selectMock });

    const { GET: readinessHandler } = await import('./route');
    const req = new NextRequest('https://orbita.test/api/readiness');
    const res = await readinessHandler(req);

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe('not_ready');
    expect(body.checks.database).toBe('error');
  });

  it('GET /api/liveness retorna 200 com status alive', async () => {
    const { GET: livenessHandler } = await import('../liveness/route');
    const req = new NextRequest('https://orbita.test/api/liveness');
    const res = await livenessHandler(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('alive');
  });
});
