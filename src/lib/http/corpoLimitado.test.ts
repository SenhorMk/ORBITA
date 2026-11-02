import { describe, expect, it } from 'vitest';
import { lerCorpoLimitado } from './corpoLimitado';

function fluxoDe(...partes: Uint8Array[]): Request {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      partes.forEach((p) => controller.enqueue(p));
      controller.close();
    },
  });
  return new Request('https://orbita.test/', { method: 'POST', body, duplex: 'half' } as RequestInit & { duplex: 'half' });
}

describe('lerCorpoLimitado', () => {
  it('devolve exatamente os bytes recebidos, sem decodificar', async () => {
    const lido = await lerCorpoLimitado(fluxoDe(new Uint8Array([0xc3, 0x28]), new Uint8Array([0xff])), 10);
    expect(lido).toEqual({ _tag: 'CorpoLido', bytes: new Uint8Array([0xc3, 0x28, 0xff]) });
  });

  it('aceita o corpo exatamente no limite e recusa um byte acima', async () => {
    expect((await lerCorpoLimitado(fluxoDe(new Uint8Array(10)), 10))._tag).toBe('CorpoLido');
    expect((await lerCorpoLimitado(fluxoDe(new Uint8Array(6), new Uint8Array(5)), 10))._tag).toBe('CorpoGrandeDemais');
  });

  it('recusa pelo Content-Length declarado sem ler o corpo', async () => {
    const req = new Request('https://orbita.test/', { method: 'POST', headers: { 'content-length': '11' }, body: 'x' });
    expect((await lerCorpoLimitado(req, 10))._tag).toBe('CorpoGrandeDemais');
  });

  it('sem corpo devolve zero bytes', async () => {
    expect(await lerCorpoLimitado(new Request('https://orbita.test/', { method: 'POST' }), 10)).toEqual({ _tag: 'CorpoLido', bytes: new Uint8Array() });
  });
});
