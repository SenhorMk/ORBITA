import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createLocalDatabaseClient } from '../../../scripts/local-database-client.mjs';
import { criarConsultaDeCasos } from '@/app/api/sac/casos/handlers';
import type { OrganizationContextResult } from '@/lib/organizationAuthorization';
import { listarCasos, listarEventosRecebidos } from '@/services/sac/leituraDeCasos';

import { consumirInboxUmaVez } from './consumidorInboxChatwoot';
import { criarPortaDoConsumidorInbox } from './consumidorInboxChatwootSupabase';

/**
 * Prova integrada do MSG-006, com fixtures sintéticas. Caminho real: rota do webhook
 * → PostgREST → Postgres → worker → leitura do operador. Dublês: o Chatwoot (a
 * entrega é assinada aqui) e a sessão do operador (o laboratório não tem GoTrue).
 * NÃO é E2E real. Roda só por `scripts/database-integracao-consumidor-inbox.mjs`.
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

const URL_DO_PROXY = `http://127.0.0.1:${process.env.ORBITA_LAB_PROXY_PORT}`;
const ORG_A = 'e6200000-0000-4000-8000-00000000000a';
const ORG_B = 'e6200000-0000-4000-8000-00000000000b';
const DONO_A = 'e6200000-0000-4000-8000-0000000000a1';
const DONO_B = 'e6200000-0000-4000-8000-0000000000b1';
const CONEXAO_A = 'e6200000-0000-4000-8000-0000000000c1';
const CONEXAO_B = 'e6200000-0000-4000-8000-0000000000c2';
const SEGREDO_A = 'segredo-sintetico-a-1234567890';
const SEGREDO_B = 'segredo-sintetico-b-1234567890';

/** O caminho até o banco, com a queda injetável na chamada que aplica o evento. */
type Queda = 'nenhuma' | 'antes_de_chegar' | 'depois_do_commit';
let queda: Queda = 'nenhuma';

function criarProxy(): http.Server {
  return http.createServer((pedido, resposta) => {
    const caminho = (pedido.url ?? '').replace(/^\/rest\/v1/, '');
    const naAplicacao = caminho.startsWith('/rpc/aplicar_evento_inbox_chatwoot');
    if (naAplicacao && queda === 'antes_de_chegar') {
      pedido.socket.destroy();
      return;
    }
    const encaminhado = http.request({
      host: '127.0.0.1',
      port: Number(process.env.ORBITA_LAB_REST_PORT),
      method: pedido.method,
      path: caminho,
      headers: { ...pedido.headers, host: `127.0.0.1:${process.env.ORBITA_LAB_REST_PORT}` },
    }, (origem) => {
      if (naAplicacao && queda === 'depois_do_commit') {
        // O banco já respondeu; quem chamou nunca fica sabendo.
        origem.resume();
        origem.on('end', () => pedido.socket.destroy());
        return;
      }
      resposta.writeHead(origem.statusCode ?? 502, origem.headers);
      origem.pipe(resposta);
    });
    encaminhado.on('error', () => pedido.socket.destroy());
    pedido.pipe(encaminhado);
  });
}

const admin = createLocalDatabaseClient('orbita-integracao-m6');
let proxy: http.Server;
let cliente: SupabaseClient;
let postarNoWebhook: (conexaoId: string, req: Request) => Promise<Response>;

function assinar(segredo: string, corpo: string, delivery?: string) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const hex = crypto.createHmac('sha256', segredo).update(`${timestamp}.`).update(corpo).digest('hex');
  return {
    'x-chatwoot-signature': `sha256=${hex}`,
    'x-chatwoot-timestamp': timestamp,
    ...(delivery ? { 'x-chatwoot-delivery': delivery } : {}),
  };
}

async function entregar(corpo: Record<string, unknown>, opcoes: { delivery?: string; conexao?: string; segredo?: string } = {}) {
  const conexao = opcoes.conexao ?? CONEXAO_A;
  const texto = JSON.stringify(corpo);
  const req = new Request(`https://orbita.test/api/chatwoot/webhook/${conexao}`, {
    method: 'POST',
    headers: assinar(opcoes.segredo ?? SEGREDO_A, texto, opcoes.delivery),
    body: texto,
  });
  return postarNoWebhook(conexao, req);
}

function mensagem(id: number, conversa: number, contato: number, extra: Record<string, unknown> = {}) {
  return {
    event: 'message_created',
    account: { id: 1 },
    id,
    content: `CONTEUDO-SINTETICO-${id}`,
    message_type: 'incoming',
    inbox: { id: 1 },
    conversation: { id: conversa, inbox_id: 1, status: 'open', contact: { id: contato, name: `NOME-SINTETICO-${contato}` } },
    sender: { id: contato, name: `NOME-SINTETICO-${contato}`, type: 'contact' },
    ...extra,
  };
}

const consumir = (workerId: string, limite = 20) =>
  consumirInboxUmaVez(criarPortaDoConsumidorInbox(cliente), { workerId, limite, leaseSegundos: 30 });

async function evento(chave: string, conexao = CONEXAO_A) {
  const { rows } = await admin.query(
    `select id, status, disposicao, last_error, attempts, fencing_token::int as token, caso_id
       from public.inbox_eventos_chatwoot where conexao_id = $1 and idempotency_key = $2`, [conexao, chave]);
  return rows[0];
}

async function contar(tabela: string, where: string, ...args: unknown[]): Promise<number> {
  const { rows } = await admin.query(`select count(*)::int as n from public.${tabela} where ${where}`, args);
  return rows[0].n;
}

async function auditoriasDoCaso(casoId: string) {
  return contar('eventos_auditoria_sistema', "acao = 'sac.case_opened' and recurso_id = $1 and actor_id is null", casoId);
}

async function vencerLease(id: string) {
  await admin.query("update public.inbox_eventos_chatwoot set lease_expires_at = clock_timestamp() - interval '1 second' where id = $1", [id]);
}

function contextoDe(organizacao: string, usuario: string): OrganizationContextResult {
  return {
    _tag: 'OrganizationContextResolved',
    context: { userId: usuario, organizationId: organizacao, role: 'member', capabilities: new Set(['organization:access']) },
  } as unknown as OrganizationContextResult;
}

async function verComoOperador(organizacao: string, usuario: string) {
  const consulta = criarConsultaDeCasos({
    resolverContexto: async () => contextoDe(organizacao, usuario),
    listarEventos: (scope) => listarEventosRecebidos(cliente, scope),
    listarCasos: (scope) => listarCasos(cliente, scope),
  });
  const resposta = await consulta(new Request('https://orbita.test/api/sac/casos'));
  expect(resposta.status).toBe(200);
  return resposta.json();
}

beforeAll(async () => {
  await admin.connect();
  // Eventos de outros ensaios não entram nesta prova.
  await admin.query("update public.inbox_eventos_chatwoot set available_at = 'infinity' where status in ('received', 'failed')");
  await admin.query("update public.inbox_eventos_chatwoot set status = 'failed', disposicao = 'falha_definitiva' where status = 'processing'");
  await admin.query('insert into auth.users (id, email) values ($1, $2), ($3, $4)', [DONO_A, 'dono-a-int-m6@orbita.test', DONO_B, 'dono-b-int-m6@orbita.test']);
  await admin.query(
    `insert into public.organizacoes (id, nome, slug, status) values
       ($1, 'Int A', 'int-a-m6', 'active'), ($2, 'Int B', 'int-b-m6', 'active')`, [ORG_A, ORG_B]);
  await admin.query(
    `insert into public.membros_organizacao (organizacao_id, user_id, papel) values ($1, $2, 'owner'), ($3, $4, 'owner')`,
    [ORG_A, DONO_A, ORG_B, DONO_B]);
  await admin.query(
    `insert into public.conexoes_integracao (id, organizacao_id, provedor, nome, status) values
       ($1, $3, 'chatwoot', 'A', 'conectado'), ($2, $4, 'chatwoot', 'B', 'conectado')`, [CONEXAO_A, CONEXAO_B, ORG_A, ORG_B]);
  const { encrypt } = await import('@/lib/crypto');
  for (const [conexao, org, segredo] of [[CONEXAO_A, ORG_A, SEGREDO_A], [CONEXAO_B, ORG_B, SEGREDO_B]] as const) {
    await admin.query(
      'insert into public.credenciais_integracao (conexao_id, organizacao_id, dados_cifrados) values ($1, $2, $3)',
      [conexao, org, encrypt(JSON.stringify({ api_url: 'https://chatwoot.invalid', api_token: 'ci-test-token', account_id: '1', webhook_secret: segredo }))],
    );
  }
  proxy = criarProxy();
  await new Promise<void>((resolve) => { proxy.listen(Number(process.env.ORBITA_LAB_PROXY_PORT), '127.0.0.1', resolve); });
  cliente = createClient(URL_DO_PROXY, jwtDoLaboratorio('service_role'), { auth: { persistSession: false, autoRefreshToken: false } });
  const { POST } = await import('@/app/api/chatwoot/webhook/[conexaoId]/route');
  postarNoWebhook = (conexaoId, req) => POST(req, { params: Promise.resolve({ conexaoId }) });
});

afterAll(async () => {
  proxy.closeAllConnections();
  await new Promise((resolve) => { proxy.close(resolve); });
  await admin.end();
});

describe('webhook → inbox → ACK → worker → caso → operador', () => {
  it('caminho feliz: o ACK vem antes do efeito, e o operador vê recebida e depois processada', async () => {
    const resposta = await entregar(mensagem(1000, 100, 10), { delivery: 'int-1000' });
    expect(resposta.status).toBe(200);
    expect(await resposta.json()).toEqual({ success: true });

    const chave = 'v2:message_created:msg:1000';
    expect(await evento(chave)).toMatchObject({ status: 'received', attempts: 0, caso_id: null });
    expect(await contar('sac_cases', 'organizacao_id = $1', ORG_A)).toBe(0);
    expect(await contar('chatwoot_messages', 'organizacao_id = $1', ORG_A)).toBe(0);
    const antes = await verComoOperador(ORG_A, DONO_A);
    expect(antes.eventos[0]).toMatchObject({ estado: 'recebida', casoId: null });

    expect(await consumir('w-feliz')).toMatchObject({ reivindicados: 1, processados: 1, falhas: 0 });

    const concluido = await evento(chave);
    expect(concluido).toMatchObject({ status: 'processed', disposicao: 'caso_aberto', attempts: 1, token: 1 });
    expect(await contar('sac_cases', "organizacao_id = $1 and phase = 'TRIAGE' and ator_tipo = 'system'", ORG_A)).toBe(1);
    expect(await auditoriasDoCaso(concluido.caso_id)).toBe(1);
    const { rows: [espelho] } = await admin.query(
      `select m.content, v.conexao_id, c.name from public.chatwoot_messages m
         join public.chatwoot_conversations v on v.id_local = m.conversa_id_local
         join public.chatwoot_contacts c on c.id_local = v.contato_id_local
        where m.organizacao_id = $1 and m.id_externo = '1000'`, [ORG_A]);
    expect(espelho).toEqual({ content: 'CONTEUDO-SINTETICO-1000', conexao_id: CONEXAO_A, name: 'NOME-SINTETICO-10' });

    const depois = await verComoOperador(ORG_A, DONO_A);
    expect(depois.eventos[0]).toMatchObject({ estado: 'processada', disposicao: 'caso_aberto', casoId: concluido.caso_id });
    expect(depois.casos).toEqual([expect.objectContaining({ id: concluido.caso_id, fase: 'TRIAGE', versao: 1 })]);
    expect(JSON.stringify(depois)).not.toMatch(/CONTEUDO-SINTETICO|NOME-SINTETICO/u);
  });

  it('a outra organização não vê o caso; os mesmos ids remotos em B abrem o caso de B', async () => {
    expect((await verComoOperador(ORG_B, DONO_B)).casos).toEqual([]);
    expect((await entregar(mensagem(1000, 100, 10), { conexao: CONEXAO_B, segredo: SEGREDO_B, delivery: 'int-b-1000' })).status).toBe(200);
    await consumir('w-b');
    const deB = await verComoOperador(ORG_B, DONO_B);
    expect(deB.casos).toHaveLength(1);
    const deA = await verComoOperador(ORG_A, DONO_A);
    expect(deA.casos).toHaveLength(1);
    expect(deA.casos[0].id).not.toBe(deB.casos[0].id);
  });

  it('entrega assinada com o segredo de B na URL de A: 401 e nada gravado', async () => {
    const res = await entregar(mensagem(1001, 100, 10), { segredo: SEGREDO_B });
    expect(res.status).toBe(401);
    expect(await evento('v2:message_created:msg:1001')).toBeUndefined();
  });

  it('redelivery depois de processado: 200, nenhum evento novo, nenhum claim, um caso', async () => {
    const res = await entregar(mensagem(1000, 100, 10), { delivery: 'int-1000-de-novo' });
    expect(res.status).toBe(200);
    expect(await consumir('w-redelivery')).toMatchObject({ reivindicados: 0 });
    expect(await contar('inbox_eventos_chatwoot', "conexao_id = $1 and idempotency_key = 'v2:message_created:msg:1000'", CONEXAO_A)).toBe(1);
    expect(await contar('sac_cases', 'organizacao_id = $1', ORG_A)).toBe(1);
  });

  it('caminho de falha: filho antes do pai fica visível e, com o pai, conclui sem caso duplicado', async () => {
    const orfa = mensagem(1100, 110, 11, { conversation: { id: 110, inbox_id: 1 }, sender: { type: 'contact' } });
    expect((await entregar(orfa)).status).toBe(200);
    expect(await consumir('w-orfa')).toMatchObject({ falhas: 1 });

    const chave = 'v2:message_created:msg:1100';
    const falhou = await evento(chave);
    expect(falhou).toMatchObject({ status: 'failed', disposicao: null, last_error: 'falha_23503' });
    expect(await contar('chatwoot_messages', "organizacao_id = $1 and id_externo = '1100'", ORG_A)).toBe(0);
    expect((await verComoOperador(ORG_A, DONO_A)).eventos[0]).toMatchObject({ estado: 'falha_com_retentativa', motivo: 'falha_23503' });

    // Antes do backoff vencer, o pai chega por outra mensagem da mesma conversa.
    expect((await entregar(mensagem(1101, 110, 11))).status).toBe(200);
    expect(await consumir('w-pai')).toMatchObject({ processados: 1 });

    await admin.query('update public.inbox_eventos_chatwoot set available_at = clock_timestamp() where id = $1', [falhou.id]);
    expect(await consumir('w-retomada')).toMatchObject({ processados: 1 });
    expect(await evento(chave)).toMatchObject({ status: 'processed', disposicao: 'mensagem_no_caso', attempts: 2 });
    expect(await contar('sac_cases', "organizacao_id = $1 and conversa_id_local in (select id_local from public.chatwoot_conversations where id_externo = '110' and organizacao_id = $1)", ORG_A)).toBe(1);
  });

  it('evento desconhecido termina ignored, com disposição visível e sem espelho', async () => {
    const corpo = { event: 'conversation_created', account: { id: 1 }, id: 1200, conversation: { id: 120, contact: { id: 12, name: 'X' } } };
    expect((await entregar(corpo, { delivery: 'int-1200' })).status).toBe(200);
    expect(await consumir('w-desconhecido')).toMatchObject({ ignorados: 1 });
    const { rows: [linha] } = await admin.query(
      "select status, disposicao from public.inbox_eventos_chatwoot where event_type = 'conversation_created' and conexao_id = $1", [CONEXAO_A]);
    expect(linha).toEqual({ status: 'ignored', disposicao: 'evento_desconhecido' });
    expect(await contar('chatwoot_conversations', "organizacao_id = $1 and id_externo = '120'", ORG_A)).toBe(0);
    expect((await verComoOperador(ORG_A, DONO_A)).eventos[0]).toMatchObject({ estado: 'ignorada', disposicao: 'evento_desconhecido' });
  });

  it('entrada que nunca vai dar certo: falha definitiva, auditada, sem novo claim', async () => {
    expect((await entregar(mensagem(3_000_000_000, 130, 13))).status).toBe(200);
    expect(await consumir('w-invalida')).toMatchObject({ falhas: 1 });
    expect(await evento('v2:message_created:msg:3000000000')).toMatchObject({ status: 'failed', disposicao: 'falha_definitiva', last_error: 'id_fora_da_faixa' });
    expect(await contar('eventos_auditoria_sistema', "acao = 'chatwoot.inbox_event_failed' and organizacao_id = $1 and actor_id is null", ORG_A)).toBe(1);
    expect(await consumir('w-invalida-2')).toMatchObject({ reivindicados: 0 });
  });

  it('queda antes do commit (a chamada não chega ao banco): retomada depois da lease abre um caso', async () => {
    expect((await entregar(mensagem(1300, 140, 14))).status).toBe(200);
    queda = 'antes_de_chegar';
    expect(await consumir('w-morre')).toMatchObject({ reivindicados: 1, semResposta: 1, falhas: 0 });
    queda = 'nenhuma';

    const chave = 'v2:message_created:msg:1300';
    const emVoo = await evento(chave);
    expect(emVoo).toMatchObject({ status: 'processing', token: 1, caso_id: null });
    expect(await contar('chatwoot_messages', "organizacao_id = $1 and id_externo = '1300'", ORG_A)).toBe(0);
    expect(await consumir('w-cedo')).toMatchObject({ reivindicados: 0 });

    await vencerLease(emVoo.id);
    expect(await consumir('w-reinicio')).toMatchObject({ processados: 1 });
    const final = await evento(chave);
    expect(final).toMatchObject({ status: 'processed', disposicao: 'caso_aberto', token: 2, attempts: 2 });
    expect(await auditoriasDoCaso(final.caso_id)).toBe(1);
  });

  it('queda depois do commit (ACK da RPC perdido): o reinício não repete o efeito', async () => {
    expect((await entregar(mensagem(1400, 150, 15))).status).toBe(200);
    queda = 'depois_do_commit';
    expect(await consumir('w-morre-2')).toMatchObject({ reivindicados: 1, semResposta: 1 });
    queda = 'nenhuma';

    const final = await evento('v2:message_created:msg:1400');
    expect(final).toMatchObject({ status: 'processed', disposicao: 'caso_aberto', token: 1 });
    expect(await consumir('w-reinicio-2')).toMatchObject({ reivindicados: 0 });
    expect(await auditoriasDoCaso(final.caso_id)).toBe(1);
    expect(await contar('sac_cases', 'evento_origem_id = $1', final.id)).toBe(1);
  });

  it('dois workers pela porta real: 20 mensagens de 4 conversas, cada uma processada uma vez, 4 casos', async () => {
    for (let i = 0; i < 20; i += 1) expect((await entregar(mensagem(1500 + i, 160 + (i % 4), 16))).status).toBe(200);
    const antes = await contar('sac_cases', 'organizacao_id = $1', ORG_A);
    const passadas = async (worker: string) => {
      let total = 0;
      for (;;) {
        const r = await consumir(worker, 3);
        if (r.reivindicados === 0) return total;
        total += r.processados;
      }
    };
    const [a, b] = await Promise.all([passadas('w-par-a'), passadas('w-par-b')]);
    expect(a + b).toBe(20);
    expect(await contar('sac_cases', 'organizacao_id = $1', ORG_A)).toBe(antes + 4);
    expect(await contar('inbox_eventos_chatwoot', "conexao_id = $1 and idempotency_key like 'v2:message_created:msg:15%' and (fencing_token <> 1 or attempts <> 1)", CONEXAO_A)).toBe(0);
  });

  it('nenhum cliente aciona o consumidor: anon e authenticated recusados pelo PostgREST real', async () => {
    for (const papel of ['anon', 'authenticated']) {
      const navegador = createClient(URL_DO_PROXY, jwtDoLaboratorio(papel), { auth: { persistSession: false, autoRefreshToken: false } });
      const claim = await navegador.rpc('reivindicar_eventos_inbox_chatwoot', { p_worker: 'x', p_limite: 1, p_lease_segundos: 60 });
      const aplicar = await navegador.rpc('aplicar_evento_inbox_chatwoot', {
        p_evento_id: '00000000-0000-4000-8000-000000000000', p_worker: 'x', p_fencing_token: 1, p_comando: { evento: 'x', acao: 'ignorar' },
      });
      const casos = await navegador.from('sac_cases').select('id');
      expect([claim.error?.code, aplicar.error?.code, casos.error?.code]).toEqual(['42501', '42501', '42501']);
    }
  });
});

describe('processo worker real', () => {
  const RAIZ = path.resolve(__dirname, '../../..');

  function iniciar(ligado: boolean): { filho: ChildProcess; saida: () => string } {
    const lab = { chave: jwtDoLaboratorio('service_role') };
    const filho = spawn(process.execPath, [
      'node_modules/ts-node/dist/bin.js', '--transpile-only', '--project', 'scripts/tsconfig.worker.json', 'scripts/worker-inbox-chatwoot.ts',
    ], {
      cwd: RAIZ,
      env: {
        NODE_ENV: 'test',
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        NEXT_PUBLIC_SUPABASE_URL: URL_DO_PROXY,
        SUPABASE_SERVICE_ROLE_KEY: lab.chave,
        CHATWOOT_INBOX_WORKER_ENABLED: ligado ? 'true' : 'false',
        CHATWOOT_INBOX_WORKER_POLL_MS: '100',
        CHATWOOT_INBOX_WORKER_IDLE_MAX_MS: '200',
        CHATWOOT_INBOX_WORKER_LEASE_SECONDS: '5',
      },
    });
    let texto = '';
    filho.stdout?.on('data', (d) => { texto += String(d); });
    filho.stderr?.on('data', (d) => { texto += String(d); });
    return { filho, saida: () => texto };
  }

  async function ate(condicao: () => Promise<boolean>, ms = 60_000) {
    const fim = Date.now() + ms;
    while (Date.now() < fim) {
      if (await condicao()) return;
      await new Promise((resolve) => { setTimeout(resolve, 100); });
    }
    throw new Error('Condição não atingida a tempo.');
  }

  const fim = (filho: ChildProcess) => new Promise<number | null>((resolve) => {
    if (filho.exitCode !== null) resolve(filho.exitCode);
    else filho.once('exit', (codigo) => resolve(codigo));
  });

  it('kill switch desligado: o processo termina sem reivindicar', async () => {
    expect((await entregar(mensagem(1600, 170, 17))).status).toBe(200);
    const { filho, saida } = iniciar(false);
    expect(await fim(filho)).toBe(0);
    expect(saida()).toContain('chatwoot.inbox.worker_desligado');
    expect(await evento('v2:message_created:msg:1600')).toMatchObject({ status: 'received', attempts: 0 });
  });

  it('ligado: processa o evento pendente, e os logs não levam conteúdo', async () => {
    const { filho, saida } = iniciar(true);
    try {
      await ate(async () => (await evento('v2:message_created:msg:1600'))?.status === 'processed');
    } finally {
      filho.kill('SIGKILL');
      await fim(filho);
    }
    expect(saida()).toContain('chatwoot.inbox.termino');
    expect(saida()).not.toMatch(/CONTEUDO-SINTETICO|NOME-SINTETICO/u);
  });

  it('morto de verdade no meio da transação e reiniciado: conclui com um caso e uma auditoria', async () => {
    expect((await entregar(mensagem(1700, 180, 18))).status).toBe(200);
    const trava = createLocalDatabaseClient('orbita-integracao-m6-trava');
    await trava.connect();
    const chaveDaTrava = `inbox_chatwoot:${CONEXAO_A}:180`;
    await trava.query('select pg_advisory_lock(hashtextextended($1, 0))', [chaveDaTrava]);
    const primeiro = iniciar(true);
    try {
      // A aplicação parou no lock por conversa: linha travada, nada commitado.
      await ate(async () => (await admin.query("select 1 from pg_locks where locktype = 'advisory' and not granted")).rows.length > 0);
      expect(await contar('chatwoot_messages', "organizacao_id = $1 and id_externo = '1700'", ORG_A)).toBe(0);
      primeiro.filho.kill('SIGKILL');
      await fim(primeiro.filho);
    } finally {
      await trava.query('select pg_advisory_unlock(hashtextextended($1, 0))', [chaveDaTrava]);
      await trava.end();
    }

    // O PostgREST pode ainda concluir a transação órfã; se não concluir, a lease vence.
    const segundo = iniciar(true);
    try {
      await ate(async () => (await evento('v2:message_created:msg:1700'))?.status === 'processed');
      // Passadas a mais não mudam nada.
      await new Promise((resolve) => { setTimeout(resolve, 1500); });
    } finally {
      segundo.filho.kill('SIGKILL');
      await fim(segundo.filho);
    }
    const final = await evento('v2:message_created:msg:1700');
    expect(final).toMatchObject({ status: 'processed', disposicao: 'caso_aberto' });
    expect(await contar('sac_cases', 'evento_origem_id = $1', final.id)).toBe(1);
    expect(await auditoriasDoCaso(final.caso_id)).toBe(1);
    expect(await contar('chatwoot_messages', "organizacao_id = $1 and id_externo = '1700'", ORG_A)).toBe(1);
  });
});
