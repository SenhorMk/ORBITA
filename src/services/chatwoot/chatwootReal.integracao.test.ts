import crypto from 'node:crypto';
import http from 'node:http';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  bancosSemPortaNoHost,
  compose,
  destruirERestaurarBanco,
  esperarChatwoot,
  ipv4DoHostNoContainer,
  provisionarContas,
  VERSAO_FIXADA,
} from '../../../scripts/chatwoot-dev.mjs';
import { createLocalDatabaseClient } from '../../../scripts/local-database-client.mjs';
import { criarConsultaDeCasos } from '@/app/api/sac/casos/handlers';
import type { OrganizationContextResult } from '@/lib/organizationAuthorization';
import { listarCasos, listarEventosRecebidos } from '@/services/sac/leituraDeCasos';

import { ChatwootAdapter } from './chatwootAdapter';
import { consumirInboxUmaVez } from './consumidorInboxChatwoot';
import { criarPortaDoConsumidorInbox } from './consumidorInboxChatwootSupabase';

/**
 * Prova do MSG-001. Sem dublê do provedor: Chatwoot CE real entrega, por rede, à rota
 * real do webhook; dali PostgREST, Postgres e worker reais, até a leitura do operador.
 * Dublê só a sessão do operador, porque o laboratório não tem GoTrue. Dados sintéticos.
 * Os testes formam uma jornada e dependem da ordem. Roda por `npm run test:chatwoot`.
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

const BASE = String(process.env.CHATWOOT_REAL_URL);
const PORTA_DO_RECEPTOR = 3188;
const PORTA_NOVA_DO_RECEPTOR = 3189;
const ORG = { a: 'e0010000-0000-4000-8000-00000000000a', b: 'e0010000-0000-4000-8000-00000000000b' } as const;
const DONO = { a: 'e0010000-0000-4000-8000-0000000000a1', b: 'e0010000-0000-4000-8000-0000000000b1' } as const;
const CONEXAO = { a: 'e0010000-0000-4000-8000-0000000000c1', b: 'e0010000-0000-4000-8000-0000000000c2' } as const;

type Letra = 'a' | 'b';
interface Conta {
  readonly accountId: number;
  readonly token: string;
  inboxId: number;
  inboxIdentifier: string;
  webhookId: number;
  segredo: string;
  contatoId: number;
  sourceId: string;
  conversaId: number;
}
interface Entrega {
  readonly porta: number;
  readonly conexao: string;
  readonly corpo: Buffer;
  readonly assinatura: string;
  readonly timestamp: string;
  readonly delivery: string | null;
  readonly status: number;
  readonly evento: string;
  readonly idDoEvento: unknown;
}

const admin = createLocalDatabaseClient('orbita-chatwoot-real');
const entregas: Entrega[] = [];
const contas = {} as Record<Letra, Conta>;
const receptores: http.Server[] = [];
let proxy: http.Server;
let cliente: SupabaseClient;
let hostNoContainer: string;
let postarNoWebhook: (conexaoId: string, req: Request) => Promise<Response>;

function urlDoWebhook(porta: number, conexao: string): string {
  return `http://${hostNoContainer}:${porta}/api/chatwoot/webhook/${conexao}`;
}

function criarReceptor(porta: number): Promise<http.Server> {
  const servidor = http.createServer((pedido, resposta) => {
    const pedacos: Buffer[] = [];
    pedido.on('data', (d: Buffer) => pedacos.push(d));
    pedido.on('end', () => {
      void (async () => {
        const corpo = Buffer.concat(pedacos);
        const conexao = (pedido.url ?? '').split('/').pop() ?? '';
        const headers = new Headers();
        for (const nome of ['x-chatwoot-signature', 'x-chatwoot-timestamp', 'x-chatwoot-delivery', 'content-type']) {
          const valor = pedido.headers[nome];
          if (typeof valor === 'string') headers.set(nome, valor);
        }
        const res = await postarNoWebhook(conexao, new Request(`https://orbita.test/api/chatwoot/webhook/${conexao}`, { method: 'POST', headers, body: corpo }));
        const json = JSON.parse(corpo.toString()) as { event: string; id: unknown };
        entregas.push({
          porta,
          conexao,
          corpo,
          assinatura: headers.get('x-chatwoot-signature') ?? '',
          timestamp: headers.get('x-chatwoot-timestamp') ?? '',
          delivery: headers.get('x-chatwoot-delivery'),
          status: res.status,
          evento: json.event,
          idDoEvento: json.id,
        });
        resposta.writeHead(res.status);
        resposta.end();
      })();
    });
  });
  return new Promise((resolve) => { servidor.listen(porta, '127.0.0.1', () => resolve(servidor)); });
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

async function api(letra: Letra, metodo: string, caminho: string, corpo?: unknown) {
  const conta = contas[letra];
  const res = await fetch(`${BASE}/api/v1/accounts/${conta.accountId}${caminho}`, {
    method: metodo,
    headers: { api_access_token: conta.token, 'content-type': 'application/json' },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  expect(res.status, `${metodo} ${caminho}`).toBe(200);
  return res.json();
}

/** O caminho do cliente: a API pública do canal, sem token de agente. */
async function mensagemDoCliente(letra: Letra, content: string): Promise<number> {
  const conta = contas[letra];
  const res = await fetch(`${BASE}/public/api/v1/inboxes/${conta.inboxIdentifier}/contacts/${conta.sourceId}/conversations/${conta.conversaId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { id: number }).id;
}

async function esperarEntrega(filtro: (e: Entrega) => boolean, ms = 60_000): Promise<Entrega> {
  const limite = Date.now() + ms;
  while (Date.now() < limite) {
    const achada = entregas.find(filtro);
    if (achada) return achada;
    await new Promise((resolve) => { setTimeout(resolve, 250); });
  }
  throw new Error('A entrega real do Chatwoot não chegou');
}

const daMensagem = (id: number, evento = 'message_created') => (e: Entrega) => e.evento === evento && e.idDoEvento === id;

function assinaturaDe(entrega: Entrega, segredo: string): string {
  return `sha256=${crypto.createHmac('sha256', segredo).update(`${entrega.timestamp}.`).update(entrega.corpo).digest('hex')}`;
}

function repostar(entrega: Entrega, conexao: string, corpo: Buffer = entrega.corpo) {
  const headers = new Headers({ 'x-chatwoot-signature': entrega.assinatura, 'x-chatwoot-timestamp': entrega.timestamp });
  if (entrega.delivery) headers.set('x-chatwoot-delivery', entrega.delivery);
  return postarNoWebhook(conexao, new Request(`https://orbita.test/api/chatwoot/webhook/${conexao}`, { method: 'POST', headers, body: new Uint8Array(corpo) }));
}

const consumir = (workerId: string) =>
  consumirInboxUmaVez(criarPortaDoConsumidorInbox(cliente), { workerId, limite: 20, leaseSegundos: 30, recebidosDesde: '1970-01-01T00:00:00Z' });

async function contar(tabela: string, where: string, ...args: unknown[]): Promise<number> {
  const { rows } = await admin.query(`select count(*)::int as n from public.${tabela} where ${where}`, args);
  return rows[0].n;
}

async function verComoOperador(letra: Letra) {
  const contexto = {
    _tag: 'OrganizationContextResolved',
    context: { userId: DONO[letra], organizationId: ORG[letra], role: 'member', capabilities: new Set(['organization:access']) },
  } as unknown as OrganizationContextResult;
  const consulta = criarConsultaDeCasos({
    resolverContexto: async () => contexto,
    listarEventos: (scope) => listarEventosRecebidos(cliente, scope),
    listarCasos: (scope) => listarCasos(cliente, scope),
  });
  const resposta = await consulta(new Request('https://orbita.test/api/sac/casos'));
  expect(resposta.status).toBe(200);
  return resposta.json();
}

async function gravarSegredoDaConexao(letra: Letra, segredo: string) {
  const { encrypt } = await import('@/lib/crypto');
  const conta = contas[letra];
  const dados = encrypt(JSON.stringify({ api_url: BASE, api_token: conta.token, account_id: String(conta.accountId), webhook_secret: segredo }));
  await admin.query(
    `insert into public.credenciais_integracao (conexao_id, organizacao_id, dados_cifrados) values ($1, $2, $3)
       on conflict (conexao_id) do update set dados_cifrados = excluded.dados_cifrados`,
    [CONEXAO[letra], ORG[letra], dados],
  );
}

async function montarConta(letra: Letra) {
  const conta = contas[letra];
  const inbox = await api(letra, 'POST', '/inboxes', { name: `API sintetica ${letra}`, channel: { type: 'api', webhook_url: '' } });
  conta.inboxId = inbox.id;
  conta.inboxIdentifier = inbox.inbox_identifier;
  const criado = await api(letra, 'POST', '/webhooks', {
    webhook: {
      name: 'orbita',
      url: urlDoWebhook(PORTA_DO_RECEPTOR, CONEXAO[letra]),
      subscriptions: ['message_created', 'message_updated', 'conversation_status_changed', 'conversation_created'],
    },
  });
  conta.webhookId = criado.payload.webhook.id;
  // O segredo que a API devolve é o único que a ORBITA conhece: é ele que precisa validar.
  conta.segredo = criado.payload.webhook.secret;
  await gravarSegredoDaConexao(letra, conta.segredo);
  const contato = await api(letra, 'POST', '/contacts', { inbox_id: conta.inboxId, name: `Contato sintetico ${letra}`, identifier: `sint-${letra}` });
  conta.contatoId = contato.payload.contact.id;
  conta.sourceId = contato.payload.contact_inbox.source_id;
  const conversa = await api(letra, 'POST', '/conversations', { inbox_id: conta.inboxId, contact_id: conta.contatoId, source_id: conta.sourceId });
  conta.conversaId = conversa.id;
}

beforeAll(async () => {
  await admin.connect();
  await admin.query('insert into auth.users (id, email) values ($1, $2), ($3, $4)', [DONO.a, 'dono-a-m1@orbita.test', DONO.b, 'dono-b-m1@orbita.test']);
  await admin.query("insert into public.organizacoes (id, nome, slug, status) values ($1, 'M1 A', 'm1-a', 'active'), ($2, 'M1 B', 'm1-b', 'active')", [ORG.a, ORG.b]);
  await admin.query("insert into public.membros_organizacao (organizacao_id, user_id, papel) values ($1, $2, 'owner'), ($3, $4, 'owner')", [ORG.a, DONO.a, ORG.b, DONO.b]);
  await admin.query(
    "insert into public.conexoes_integracao (id, organizacao_id, provedor, nome, status) values ($1, $2, 'chatwoot', 'A', 'conectado'), ($3, $4, 'chatwoot', 'B', 'conectado')",
    [CONEXAO.a, ORG.a, CONEXAO.b, ORG.b],
  );
  proxy = criarProxy();
  await new Promise<void>((resolve) => { proxy.listen(Number(process.env.ORBITA_LAB_PROXY_PORT), '127.0.0.1', resolve); });
  cliente = createClient(`http://127.0.0.1:${process.env.ORBITA_LAB_PROXY_PORT}`, jwtDoLaboratorio('service_role'), { auth: { persistSession: false, autoRefreshToken: false } });
  const { POST } = await import('@/app/api/chatwoot/webhook/[conexaoId]/route');
  postarNoWebhook = (conexaoId, req) => POST(req, { params: Promise.resolve({ conexaoId }) });
  receptores.push(await criarReceptor(PORTA_DO_RECEPTOR), await criarReceptor(PORTA_NOVA_DO_RECEPTOR));

  hostNoContainer = ipv4DoHostNoContainer();
  for (const provisionada of provisionarContas()) {
    contas[provisionada.letra as Letra] = { accountId: provisionada.account_id, token: provisionada.token } as Conta;
  }
  await montarConta('a');
  await montarConta('b');
});

afterAll(async () => {
  for (const servidor of receptores) {
    servidor.closeAllConnections();
    await new Promise((resolve) => { servidor.close(resolve); });
  }
  proxy?.closeAllConnections();
  await new Promise((resolve) => { proxy?.close(resolve); });
  await admin.end();
});

describe('Chatwoot CE real → ORBITA', () => {
  it('a instância é a versão fixada, e Postgres e Redis não têm porta no host', async () => {
    expect(await esperarChatwoot(BASE, 5)).toBe(VERSAO_FIXADA);
    expect(bancosSemPortaNoHost()).toBe(true);
  });

  it('mensagem do cliente: entrega assinada aceita, caso aberto, operador vê, cockpit mostra', async () => {
    const id = await mensagemDoCliente('a', 'MENSAGEM-SINTETICA-1');
    const entrega = await esperarEntrega(daMensagem(id));

    // #13809: nesta versão, o segredo devolvido pela API é o que assina.
    expect(entrega.assinatura).toBe(assinaturaDe(entrega, contas.a.segredo));
    expect(entrega.delivery).toMatch(/^[A-Za-z0-9._:-]{1,128}$/);
    expect(entrega.status).toBe(200);
    const chave = `v2:message_created:msg:${id}`;
    expect(await contar('inbox_eventos_chatwoot', "conexao_id = $1 and idempotency_key = $2 and status = 'received'", CONEXAO.a, chave)).toBe(1);

    expect(await consumir('w-m1')).toMatchObject({ falhas: 0 });
    const { rows: [evento] } = await admin.query('select status, disposicao, caso_id from public.inbox_eventos_chatwoot where conexao_id = $1 and idempotency_key = $2', [CONEXAO.a, chave]);
    expect(evento).toMatchObject({ status: 'processed', disposicao: 'caso_aberto' });
    const { rows: [espelho] } = await admin.query(
      `select m.content, m.message_type, m.sender_type, v.conexao_id, c.name from public.chatwoot_messages m
         join public.chatwoot_conversations v on v.id_local = m.conversa_id_local
         join public.chatwoot_contacts c on c.id_local = v.contato_id_local
        where m.organizacao_id = $1 and m.id_externo = $2`, [ORG.a, String(id)]);
    expect(espelho).toMatchObject({ content: 'MENSAGEM-SINTETICA-1', conexao_id: CONEXAO.a, name: 'Contato sintetico a' });

    const operador = await verComoOperador('a');
    expect(operador.casos).toEqual([expect.objectContaining({ id: evento.caso_id, fase: 'TRIAGE' })]);
    expect(JSON.stringify(operador)).not.toContain('MENSAGEM-SINTETICA');
    expect((await verComoOperador('b')).casos).toEqual([]);

    const cockpit = await ChatwootAdapter.forTesting({ apiUrl: BASE, apiToken: contas.a.token, accountId: String(contas.a.accountId), conexaoId: CONEXAO.a }).getMessages(contas.a.conversaId);
    expect(cockpit).toMatchObject({ _tag: 'ChatwootSuccess' });
    expect(cockpit._tag === 'ChatwootSuccess' && cockpit.data.some((m) => m.id === id && m.content === 'MENSAGEM-SINTETICA-1')).toBe(true);
    const conversas = await ChatwootAdapter.forTesting({ apiUrl: BASE, apiToken: contas.a.token, accountId: String(contas.a.accountId), conexaoId: CONEXAO.a }).getConversations();
    expect(conversas._tag === 'ChatwootSuccess' && conversas.data.map((c) => [c.id, c.meta?.sender?.id])).toEqual([[contas.a.conversaId, contas.a.contatoId]]);
  });

  it('os mesmos bytes reais de novo: deduplicado, sem segundo evento nem segundo caso', async () => {
    const original = entregas.find((e) => e.evento === 'message_created' && e.conexao === CONEXAO.a);
    expect(original).toBeDefined();
    const eventos = await contar('inbox_eventos_chatwoot', 'conexao_id = $1', CONEXAO.a);
    expect((await repostar(original as Entrega, CONEXAO.a)).status).toBe(200);
    expect(await contar('inbox_eventos_chatwoot', 'conexao_id = $1', CONEXAO.a)).toBe(eventos);
    await consumir('w-m1-replay');
    expect(await contar('sac_cases', 'organizacao_id = $1', ORG.a)).toBe(1);
  });

  it('um byte adulterado, ou os bytes de A na URL de B: 401 e nada gravado', async () => {
    const original = entregas.find((e) => e.evento === 'message_created' && e.conexao === CONEXAO.a) as Entrega;
    const antesA = await contar('inbox_eventos_chatwoot', 'conexao_id = $1', CONEXAO.a);
    const antesB = await contar('inbox_eventos_chatwoot', 'conexao_id = $1', CONEXAO.b);
    const adulterado = Buffer.from(original.corpo.toString().replace('MENSAGEM-SINTETICA-1', 'MENSAGEM-SINTETICA-2'));
    expect((await repostar(original, CONEXAO.a, adulterado)).status).toBe(401);
    expect((await repostar(original, CONEXAO.b)).status).toBe(401);
    expect(await contar('inbox_eventos_chatwoot', 'conexao_id = $1', CONEXAO.a)).toBe(antesA);
    expect(await contar('inbox_eventos_chatwoot', 'conexao_id = $1', CONEXAO.b)).toBe(antesB);
  });

  it('a conta B entrega na conexão de B, isolada da organização A', async () => {
    const id = await mensagemDoCliente('b', 'MENSAGEM-SINTETICA-B');
    const entrega = await esperarEntrega(daMensagem(id));
    expect(entrega).toMatchObject({ conexao: CONEXAO.b, status: 200 });
    await consumir('w-m1-b');
    expect(await contar('sac_cases', 'organizacao_id = $1', ORG.b)).toBe(1);
    expect(await contar('sac_cases', 'organizacao_id = $1', ORG.a)).toBe(1);
    expect(await contar('chatwoot_messages', 'organizacao_id = $1 and id_externo = $2', ORG.a, String(id))).toBe(0);
  });

  it('segredo divergente (o sintoma de #13809): falha fechada, e o Chatwoot não repete a entrega', async () => {
    await gravarSegredoDaConexao('a', 'segredo-que-nao-assina-1234567890');
    const id = await mensagemDoCliente('a', 'MENSAGEM-SINTETICA-RECUSADA');
    expect(await esperarEntrega(daMensagem(id))).toMatchObject({ status: 401 });
    expect(await contar('inbox_eventos_chatwoot', 'conexao_id = $1 and idempotency_key = $2', CONEXAO.a, `v2:message_created:msg:${id}`)).toBe(0);
    await gravarSegredoDaConexao('a', contas.a.segredo);
    await new Promise((resolve) => { setTimeout(resolve, 15_000); });
    expect(entregas.filter(daMensagem(id))).toHaveLength(1);
  });

  it('resposta do agente, nota privada e atualização: espelhadas, sem abrir caso; o status chega', async () => {
    const adapter = ChatwootAdapter.forTesting({ apiUrl: BASE, apiToken: contas.a.token, accountId: String(contas.a.accountId), conexaoId: CONEXAO.a });
    const resposta = await adapter.sendMessage(contas.a.conversaId, 'RESPOSTA-SINTETICA');
    if (resposta._tag !== 'ChatwootSuccess') throw new Error(`Envio falhou: ${resposta.reason}`);
    const nota = await api('a', 'POST', `/conversations/${contas.a.conversaId}/messages`, { content: 'NOTA-SINTETICA', message_type: 'outgoing', private: true });
    await api('a', 'PATCH', `/conversations/${contas.a.conversaId}/messages/${resposta.data.id}`, { status: 'delivered' });
    await api('a', 'POST', `/conversations/${contas.a.conversaId}/toggle_status`, { status: 'resolved' });

    expect(await esperarEntrega(daMensagem(Number(resposta.data.id)))).toMatchObject({ status: 200 });
    expect(await esperarEntrega(daMensagem(nota.id))).toMatchObject({ status: 200 });
    expect(await esperarEntrega(daMensagem(Number(resposta.data.id), 'message_updated'))).toMatchObject({ status: 200 });
    expect(await esperarEntrega((e) => e.evento === 'conversation_status_changed' && e.conexao === CONEXAO.a)).toMatchObject({ status: 200 });

    expect(await consumir('w-m1-agente')).toMatchObject({ falhas: 0 });
    expect(await contar('sac_cases', 'organizacao_id = $1', ORG.a)).toBe(1);
    const { rows: pendentes } = await admin.query("select event_type, status, disposicao, last_error from public.inbox_eventos_chatwoot where conexao_id = $1 and status <> 'processed'", [CONEXAO.a]);
    // `conversation_created` não tem consumidor: fica registrado e ignorado, de forma explícita.
    expect(pendentes).toEqual([{ event_type: 'conversation_created', status: 'ignored', disposicao: 'evento_desconhecido', last_error: null }]);
    expect(await contar('inbox_eventos_chatwoot', "conexao_id = $1 and disposicao = 'classificacao_inconclusiva'", CONEXAO.a)).toBe(0);
    expect(await contar('chatwoot_conversations', "conexao_id = $1 and id_externo = $2 and status = 'resolved'", CONEXAO.a, String(contas.a.conversaId))).toBe(1);
    expect(await contar('chatwoot_messages', 'organizacao_id = $1 and id_externo = $2', ORG.a, String(nota.id))).toBe(1);
  });

  it('reiniciar o Chatwoot: a conversa continua, e a próxima entrega é assinada e aceita', async () => {
    const reinicio = compose(['restart', 'rails', 'sidekiq']);
    expect(reinicio.status).toBe(0);
    expect(await esperarChatwoot(BASE)).toBe(VERSAO_FIXADA);
    const id = await mensagemDoCliente('a', 'MENSAGEM-SINTETICA-APOS-RESTART');
    expect(await esperarEntrega(daMensagem(id), 120_000)).toMatchObject({ status: 200 });
    expect(await consumir('w-m1-restart')).toMatchObject({ falhas: 0 });
  });

  it('a URL do túnel muda: atualizar o webhook leva a entrega para a nova, com o mesmo segredo', async () => {
    await api('a', 'PATCH', `/webhooks/${contas.a.webhookId}`, { webhook: { url: urlDoWebhook(PORTA_NOVA_DO_RECEPTOR, CONEXAO.a) } });
    const id = await mensagemDoCliente('a', 'MENSAGEM-SINTETICA-URL-NOVA');
    const entrega = await esperarEntrega(daMensagem(id));
    expect(entrega).toMatchObject({ porta: PORTA_NOVA_DO_RECEPTOR, status: 200 });
    expect(entrega.assinatura).toBe(assinaturaDe(entrega, contas.a.segredo));
    await consumir('w-m1-url');
  });

  it('backup e restore: o volume se perde, a mensagem volta, e a entrega seguinte segue assinada', async () => {
    destruirERestaurarBanco(String(process.env.CHATWOOT_REAL_SENHA_POSTGRES));
    expect(await esperarChatwoot(BASE)).toBe(VERSAO_FIXADA);
    const adapter = ChatwootAdapter.forTesting({ apiUrl: BASE, apiToken: contas.a.token, accountId: String(contas.a.accountId), conexaoId: CONEXAO.a });
    const mensagens = await adapter.getMessages(contas.a.conversaId);
    expect(mensagens._tag === 'ChatwootSuccess' && mensagens.data.some((m) => m.content === 'MENSAGEM-SINTETICA-1')).toBe(true);
    const id = await mensagemDoCliente('a', 'MENSAGEM-SINTETICA-APOS-RESTORE');
    const entrega = await esperarEntrega(daMensagem(id), 120_000);
    expect(entrega.status).toBe(200);
    expect(entrega.assinatura).toBe(assinaturaDe(entrega, contas.a.segredo));
    expect(await consumir('w-m1-restore')).toMatchObject({ falhas: 0 });
    expect(await contar('sac_cases', 'organizacao_id = $1', ORG.a)).toBe(1);
  });
});
