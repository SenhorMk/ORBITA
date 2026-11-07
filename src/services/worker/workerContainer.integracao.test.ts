import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createLocalDatabaseClient } from '../../../scripts/local-database-client.mjs';
import capturas from '../chatwoot/__fixtures__/chatwoot-v4.19.1-webhooks.json';

/**
 * Prova do MSG-020A: a imagem do worker, como vai rodar no host, contra o
 * laboratório (PostgREST + Postgres reais). O que se prova é o container: kill
 * switch desligado sem laço de reinícios, consumo real com ele ligado, parada
 * limpa e reinício quando trava. Roda por `npm run test:worker`.
 */

vi.hoisted(() => {
  process.env.ENCRYPTION_KEY = 'ab'.repeat(32);
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project-ref.supabase.co';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'public-key-12345678901234567890';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'server-key-12345678901234567890';
});

function jwtDoLaboratorio(role: string): string {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const corpo = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ role, exp: Math.floor(Date.now() / 1000) + 3600 })}`;
  const assinatura = crypto.createHmac('sha256', String(process.env.ORBITA_LAB_JWT_SECRET)).update(corpo).digest('base64url');
  return `${corpo}.${assinatura}`;
}

vi.mock('@/lib/supabaseServer', async () => {
  const { createClient: criar } = await import('@supabase/supabase-js');
  const nodeCrypto = await import('node:crypto');
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const corpo = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ role: 'service_role', exp: Math.floor(Date.now() / 1000) + 3600 })}`;
  const assinatura = nodeCrypto.createHmac('sha256', String(process.env.ORBITA_LAB_JWT_SECRET)).update(corpo).digest('base64url');
  return {
    supabaseServer: criar(`http://127.0.0.1:${process.env.ORBITA_LAB_PROXY_PORT}`, `${corpo}.${assinatura}`, {
      auth: { persistSession: false, autoRefreshToken: false },
    }),
  };
});

const laboratorio = { chaveDeServico: () => jwtDoLaboratorio('service_role') };
const IMAGEM = 'orbita-worker:local';
const PLATAFORMA = process.env.WORKER_PLATFORM ? ['--platform', process.env.WORKER_PLATFORM] : [];
const ORG = 'e0200000-0000-4000-8000-00000000000a';
const DONO = 'e0200000-0000-4000-8000-0000000000a1';
const CONEXAO = 'e0200000-0000-4000-8000-0000000000c1';
const SEGREDO = 'segredo-sintetico-m20-1234567890';
const CONTAINERS: string[] = [];

const admin = createLocalDatabaseClient('orbita-worker-container');
let proxy: http.Server;
let pendurado: http.Server;
let portaPendurada: number;
let postarNoWebhook: (conexaoId: string, req: Request) => Promise<Response>;

function docker(args: string[]) {
  return spawnSync('docker', args, { encoding: 'utf8', shell: false, timeout: 120_000 });
}

/** O container como o compose o sobe: só leitura, sem capacidades, com init. */
function subir(nome: string, tipo: 'inbox' | 'envio', env: Record<string, string>, extras: string[] = []) {
  docker(['rm', '-f', nome]);
  CONTAINERS.push(nome);
  const variaveis = Object.entries({
    NEXT_PUBLIC_SUPABASE_URL: `http://host.docker.internal:${process.env.ORBITA_LAB_PROXY_PORT}`,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'public-key-12345678901234567890',
    // Gerados nesta execução: o JWT assina com o segredo aleatório do laboratório.
    SUPABASE_SERVICE_ROLE_KEY: laboratorio.chaveDeServico(),
    ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? '',
    ...env,
  }).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  const r = docker(['run', '-d', ...PLATAFORMA, '--name', nome, '--add-host', 'host.docker.internal:host-gateway', '--init', '--read-only',
    '--tmpfs', '/tmp', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', ...extras, ...variaveis, IMAGEM, tipo]);
  expect(r.status, String(r.stderr)).toBe(0);
}

function estado(nome: string) {
  const r = docker(['inspect', '--format', '{{.State.Running}} {{.State.ExitCode}} {{.RestartCount}}', nome]);
  const [rodando, saida, reinicios] = String(r.stdout).trim().split(' ');
  return { rodando: rodando === 'true', saida: Number(saida), reinicios: Number(reinicios) };
}

const logs = (nome: string) => { const r = docker(['logs', nome]); return `${r.stdout}${r.stderr}`; };

async function esperarAte(condicao: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const limite = Date.now() + ms;
  while (Date.now() < limite) {
    if (await condicao()) return true;
    await new Promise((resolve) => { setTimeout(resolve, 500); });
  }
  return false;
}

function criarProxy(): http.Server {
  return http.createServer((pedido, resposta) => {
    const encaminhado = http.request({
      host: '127.0.0.1',
      port: Number(process.env.ORBITA_LAB_REST_PORT),
      method: pedido.method,
      path: (pedido.url ?? '').replace(/^\/rest\/v1/, ''),
      headers: { ...pedido.headers, host: `127.0.0.1:${process.env.ORBITA_LAB_REST_PORT}` },
    }, (origem) => {
      resposta.writeHead(origem.statusCode ?? 502, origem.headers);
      origem.pipe(resposta);
    });
    encaminhado.on('error', () => pedido.socket.destroy());
    pedido.pipe(encaminhado);
  });
}

async function contar(tabela: string, where: string, ...args: unknown[]): Promise<number> {
  const { rows } = await admin.query(`select count(*)::int as n from public.${tabela} where ${where}`, args);
  return rows[0].n;
}

beforeAll(async () => {
  await admin.connect();
  // Eventos de outros ensaios não entram nesta prova.
  await admin.query("update public.inbox_eventos_chatwoot set available_at = 'infinity' where status in ('received', 'failed')");
  await admin.query('insert into auth.users (id, email) values ($1, $2)', [DONO, 'dono-m20@orbita.test']);
  await admin.query("insert into public.organizacoes (id, nome, slug, status) values ($1, 'M20', 'm20', 'active')", [ORG]);
  await admin.query("insert into public.membros_organizacao (organizacao_id, user_id, papel) values ($1, $2, 'owner')", [ORG, DONO]);
  await admin.query("insert into public.conexoes_integracao (id, organizacao_id, provedor, nome, status) values ($1, $2, 'chatwoot', 'M20', 'conectado')", [CONEXAO, ORG]);
  const { encrypt } = await import('@/lib/crypto');
  await admin.query('insert into public.credenciais_integracao (conexao_id, organizacao_id, dados_cifrados) values ($1, $2, $3)', [
    CONEXAO, ORG,
    encrypt(JSON.stringify({ api_url: 'https://chatwoot.invalid', api_token: 'token-sintetico', account_id: String(capturas.entrada_do_cliente_api_publica.account.id), webhook_secret: SEGREDO })),
  ]);
  proxy = criarProxy();
  await new Promise<void>((resolve) => { proxy.listen(Number(process.env.ORBITA_LAB_PROXY_PORT), '127.0.0.1', resolve); });
  // Aceita a conexão e nunca responde: o banco pendurado que o vigia precisa pegar.
  pendurado = http.createServer(() => {});
  await new Promise<void>((resolve) => { pendurado.listen(0, '127.0.0.1', resolve); });
  portaPendurada = (pendurado.address() as AddressInfo).port;
  const { POST } = await import('@/app/api/chatwoot/webhook/[conexaoId]/route');
  postarNoWebhook = (conexaoId, req) => POST(req, { params: Promise.resolve({ conexaoId }) });
});

afterAll(async () => {
  for (const nome of CONTAINERS) docker(['rm', '-f', nome]);
  for (const servidor of [proxy, pendurado]) {
    servidor?.closeAllConnections();
    await new Promise((resolve) => { servidor?.close(resolve); });
  }
  await admin.end();
});

describe('a imagem do worker', () => {
  it('kill switch desligado: fica de pé, sem reinício, e para limpo no SIGTERM', async () => {
    subir('orbita-m20-desligado', 'inbox', {}, ['--restart', 'unless-stopped']);
    expect(await esperarAte(() => logs('orbita-m20-desligado').includes('chatwoot.inbox.worker_desligado'), 30_000)).toBe(true);
    await new Promise((resolve) => { setTimeout(resolve, 8_000); });
    expect(estado('orbita-m20-desligado')).toMatchObject({ rodando: true, reinicios: 0 });

    const inicio = Date.now();
    expect(docker(['stop', '-t', '30', 'orbita-m20-desligado']).status).toBe(0);
    expect(Date.now() - inicio).toBeLessThan(10_000);
    expect(estado('orbita-m20-desligado')).toMatchObject({ rodando: false, saida: 0 });
    expect(logs('orbita-m20-desligado')).toContain('worker.encerrado');
  });

  it('ligado, o container consome uma entrega real da inbox e abre o caso', async () => {
    const corpo = JSON.stringify(capturas.entrada_do_cliente_api_publica);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const assinatura = `sha256=${crypto.createHmac('sha256', SEGREDO).update(`${timestamp}.`).update(corpo).digest('hex')}`;
    const res = await postarNoWebhook(CONEXAO, new Request(`https://orbita.test/api/chatwoot/webhook/${CONEXAO}`, {
      method: 'POST',
      headers: { 'x-chatwoot-signature': assinatura, 'x-chatwoot-timestamp': timestamp, 'x-chatwoot-delivery': 'm20-entrega-1' },
      body: corpo,
    }));
    expect(res.status).toBe(200);
    expect(await contar('inbox_eventos_chatwoot', "conexao_id = $1 and status = 'received'", CONEXAO)).toBe(1);

    subir('orbita-m20-inbox', 'inbox', {
      CHATWOOT_INBOX_WORKER_ENABLED: 'true',
      CHATWOOT_INBOX_WORKER_BACKLOG_DESDE: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(await esperarAte(async () => (await contar('sac_cases', 'organizacao_id = $1', ORG)) === 1, 60_000)).toBe(true);
    expect(await contar('inbox_eventos_chatwoot', "conexao_id = $1 and status = 'processed' and disposicao = 'caso_aberto'", CONEXAO)).toBe(1);
    expect(docker(['stop', '-t', '30', 'orbita-m20-inbox']).status).toBe(0);
    expect(estado('orbita-m20-inbox')).toMatchObject({ saida: 0 });
  });

  it('o worker de envio ligado conversa com o banco sem erro, mesmo sem trabalho', async () => {
    subir('orbita-m20-envio', 'envio', {
      CHATWOOT_SEND_WORKER_ENABLED: 'true',
      CHATWOOT_SEND_WORKER_BACKLOG_DESDE: new Date().toISOString(),
    });
    expect(await esperarAte(() => logs('orbita-m20-envio').includes('chatwoot.envio.worker_iniciado'), 30_000)).toBe(true);
    await new Promise((resolve) => { setTimeout(resolve, 8_000); });
    expect(estado('orbita-m20-envio')).toMatchObject({ rodando: true });
    expect(logs('orbita-m20-envio')).not.toContain('passada_falhou');
    expect(docker(['stop', '-t', '30', 'orbita-m20-envio']).status).toBe(0);
  });

  it('banco pendurado: o vigia derruba o processo, e a política de reinício o traz de volta', async () => {
    subir('orbita-m20-travado', 'inbox', {
      NEXT_PUBLIC_SUPABASE_URL: `http://host.docker.internal:${portaPendurada}`,
      CHATWOOT_INBOX_WORKER_ENABLED: 'true',
      CHATWOOT_INBOX_WORKER_BACKLOG_DESDE: new Date().toISOString(),
      WORKER_WATCHDOG_SECONDS: '6',
    }, ['--restart', 'unless-stopped']);
    expect(await esperarAte(() => estado('orbita-m20-travado').reinicios >= 1, 60_000)).toBe(true);
    expect(logs('orbita-m20-travado')).toContain('worker.travado');
  });
});
