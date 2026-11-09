import net from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { getHttpsLocal } from './infra-local-http.mjs';

const abertos: net.Server[] = [];
afterEach(() => { for (const s of abertos.splice(0)) s.close(); });

/** Aceita a conexão e nunca responde: nem o TLS completa. */
async function servidorMudo() {
  const sockets: net.Socket[] = [];
  const fechados = { total: 0 };
  const servidor = net.createServer((s) => { sockets.push(s); s.on('close', () => { fechados.total += 1; }); s.resume(); });
  servidor.on('close', () => { for (const s of sockets) s.destroy(); });
  abertos.push(servidor);
  await new Promise<void>((r) => { servidor.listen(0, '127.0.0.1', r); });
  return { porta: (servidor.address() as net.AddressInfo).port, sockets, fechados };
}

describe('GET HTTPS local do infra-local', () => {
  it('servidor que não responde: desiste no prazo e fecha a conexão', async () => {
    const { porta, sockets, fechados } = await servidorMudo();
    const inicio = Date.now();
    const r = await getHttpsLocal({ port: porta, path: '/api', timeoutMs: 300 });
    expect(r.status).toBe(0);
    expect(r.corpo).toMatch(/timeout/u);
    expect(Date.now() - inicio).toBeLessThan(2_000);
    await new Promise((res) => { setTimeout(res, 50); });
    // A conexão foi fechada pelo cliente, não ficou aberta segurando o processo.
    expect(sockets.length).toBe(1);
    expect(fechados.total).toBe(1);
  }, 5_000);

  it('porta fechada: status 0 sem esperar o prazo', async () => {
    const { porta } = await servidorMudo();
    abertos.splice(0).forEach((s) => s.close());
    const r = await getHttpsLocal({ port: porta, path: '/api', timeoutMs: 10_000 });
    expect(r.status).toBe(0);
  }, 5_000);
});
