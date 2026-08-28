import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from './route';

describe('GET /api/liveness', () => {
  it('retorna 200 e status alive sem depender de nenhuma dependência externa', async () => {
    const req = new NextRequest('https://orbita.test/api/liveness');
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('alive');
    expect(res.headers.get('x-correlation-id')).toBeTruthy();
  });
});
