import crypto from 'node:crypto';
import http from 'node:http';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createLocalDatabaseClient } from '../../../../scripts/local-database-client.mjs';
import { criarRotaDaTriagem } from '@/app/api/sac/triagem/handlers';
import { logger } from '@/lib/observability/logger';
import type { OrganizationContextResult } from '@/lib/organizationAuthorization';
import { lerTriagemDoCaso } from '@/services/sac/leituraDaTriagem';

import { consumirTriagensUmaVez } from './consumidorTriagem';
import { criarPortaDoConsumidorTriagem } from './consumidorTriagemSupabase';
import { criarModeloFalso } from './modelosDeTriagem';
import type { ModeloDeTriagem, RespostaDoModelo } from './triagemDoCaso';

/**
 * Prova integrada do MSG-013, com dados sintéticos: o worker real (porta
 * Supabase, PostgREST, Postgres, migration 94) e a leitura real do cockpit.
 * Dublês: o modelo (o falso declarado, ou um roteirizado para falhas do
 * provedor) e a sessão do operador (o laboratório não tem GoTrue). Não chama
 * IA real. Roda só por `scripts/database-integracao-consumidor-inbox.mjs`.
 */

function jwtDoLaboratorio(role: string): string {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const corpo = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ role, exp: Math.floor(Date.now() / 1000) + 3600 })}`;
  const assinatura = crypto.createHmac('sha256', String(process.env.ORBITA_LAB_JWT_SECRET)).update(corpo).digest('base64url');
  return `${corpo}.${assinatura}`;
}

const ORG_A = 'e6130000-0000-4000-8000-00000000000a';
const ORG_B = 'e6130000-0000-4000-8000-00000000000b';
const DONO_A = 'e6130000-0000-4000-8000-0000000000a1';
const DONO_B = 'e6130000-0000-4000-8000-0000000000b1';
const CONEXAO_A = 'e6130000-0000-4000-8000-0000000000c1';
const CONEXAO_B = 'e6130000-0000-4000-8000-0000000000c2';
const TEXTO = 'TEXTO-SINTETICO-M13 pedido 1001';

const admin = createLocalDatabaseClient('orbita-triagem-integracao');
let proxy: http.Server;
let cliente: SupabaseClient;

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

/** Uma mensagem do contato pelo caminho real do MSG-006 (aceite, claim e aplicação). Devolve a conversa local. */
async function mensagemDoContato(org: string, conexao: string, mensagem: number, conversa: number, quando: string, texto = TEXTO): Promise<string> {
  const { rows: [{ evento_id: evento }] } = await admin.query(
    "select evento_id from public.aceitar_entrega_inbox_chatwoot($1, $2, null, 1, null, $3, 'message_created', '{\"event\":\"x\"}'::jsonb)",
    [org, conexao, `m13-int-${conexao}-${mensagem}`]);
  const { rows: [{ fencing_token: token }] } = await admin.query(
    "select fencing_token from public.reivindicar_eventos_inbox_chatwoot('w-int', 50, 60, 'epoch'::timestamptz) where evento_id = $1", [evento]);
  await admin.query('select * from public.aplicar_evento_inbox_chatwoot($1, $2, $3, $4)', [evento, 'w-int', token, JSON.stringify({
    evento: 'message_created', acao: 'espelhar', account_id: '1', abre_caso: true,
    contato: { id: 40 + conversa, nome: 'Contato sintetico' },
    conversa: { id: conversa, contato_id: 40 + conversa, status: 'open', inbox_id: 1, canal: 'Channel::Api' },
    mensagem: { id: mensagem, conversa_id: conversa, conteudo: texto, tipo: 'incoming', remetente_tipo: 'contact', modo: 'preservar', criada_em: quando },
  })]);
  const { rows: [{ id }] } = await admin.query(
    'select id_local as id from public.chatwoot_conversations where conexao_id = $1 and id_externo = $2', [conexao, String(conversa)]);
  return id;
}

/** Isola cada teste: só as triagens criadas por ele ficam disponíveis. */
async function congelarTriagensPendentes() {
  await admin.query("update public.outbox_eventos set next_retry_at = 'infinity' where destination = 'interno' and status in ('pending', 'failed_transient')");
}

function roteirizado(respostas: RespostaDoModelo[]): ModeloDeTriagem & { gerar: ReturnType<typeof vi.fn> } {
  const fila = [...respostas];
  return { provedor: 'teste', modelo: 'roteirizado', gerar: vi.fn(async (): Promise<RespostaDoModelo> => fila.shift() ?? { _tag: 'ErroDoProvedor' }) };
}

const passada = (modelo: ModeloDeTriagem, limiteDiario: number) => consumirTriagensUmaVez(criarPortaDoConsumidorTriagem(cliente), modelo, {
  workerId: 'w-triagem-int', limite: 5, leaseSegundos: 60, limiteDiario, timeoutMs: 5_000,
});

const escopo = (org: string, dono: string) => ({ organizationId: org, actorId: dono, role: 'owner' }) as never;

function rotaComo(org: string, dono: string, capacidades: readonly string[]) {
  return criarRotaDaTriagem({
    resolverContexto: async () => ({
      _tag: 'OrganizationContextResolved',
      context: { actorId: dono, organizationId: org, role: 'owner', capabilities: new Set(capacidades) },
    }) as unknown as OrganizationContextResult,
    ler: (scope, conversaId) => lerTriagemDoCaso(cliente, scope, conversaId),
  });
}

beforeAll(async () => {
  await admin.connect();
  await admin.query('insert into auth.users (id, email) values ($1, $2), ($3, $4)', [DONO_A, 'dono-a-m13i@orbita.test', DONO_B, 'dono-b-m13i@orbita.test']);
  await admin.query("insert into public.organizacoes (id, nome, slug, status) values ($1, 'M13 A', 'm13i-a', 'active'), ($2, 'M13 B', 'm13i-b', 'active')", [ORG_A, ORG_B]);
  await admin.query("insert into public.membros_organizacao (organizacao_id, user_id, papel) values ($1, $2, 'owner'), ($3, $4, 'owner')", [ORG_A, DONO_A, ORG_B, DONO_B]);
  await admin.query(
    "insert into public.conexoes_integracao (id, organizacao_id, provedor, nome, status) values ($1, $2, 'chatwoot', 'A', 'conectado'), ($3, $4, 'chatwoot', 'B', 'conectado')",
    [CONEXAO_A, ORG_A, CONEXAO_B, ORG_B]);
  await admin.query("update public.inbox_eventos_chatwoot set available_at = 'infinity' where status in ('received', 'failed')");
  proxy = criarProxy();
  await new Promise<void>((resolve) => { proxy.listen(Number(process.env.ORBITA_LAB_PROXY_PORT), '127.0.0.1', resolve); });
  cliente = createClient(`http://127.0.0.1:${process.env.ORBITA_LAB_PROXY_PORT}`, jwtDoLaboratorio('service_role'), { auth: { persistSession: false, autoRefreshToken: false } });
});

afterEach(() => vi.restoreAllMocks());

afterAll(async () => {
  proxy?.closeAllConnections();
  await new Promise((resolve) => { proxy?.close(resolve); });
  await admin.end();
});

describe('MSG-013 integrado: worker real → Postgres → cockpit', () => {
  it('orçamento zero (o padrão): handoff sem chamar o modelo; o cockpit mostra o motivo', async () => {
    await congelarTriagensPendentes();
    const conversa = await mensagemDoContato(ORG_A, CONEXAO_A, 1301, 130, '2026-11-16T10:00:00Z');
    const modelo = roteirizado([]);
    expect(await passada(modelo, 0)).toMatchObject({ reivindicados: 1, concluidas: 0 });
    expect(modelo.gerar).not.toHaveBeenCalled();
    const lida = await lerTriagemDoCaso(cliente, escopo(ORG_A, DONO_A), conversa);
    expect(lida._tag === 'Lida' && lida.caso?.execucao).toMatchObject({ status: 'handoff', motivo: 'sem_orcamento', triagem: null });
  });

  it('com orçamento e o modelo falso declarado: triagem gravada e lida pela rota; Org B e sem capability não leem', async () => {
    await congelarTriagensPendentes();
    const conversa = await mensagemDoContato(ORG_A, CONEXAO_A, 1311, 131, '2026-11-16T10:01:00Z');
    expect(await passada(criarModeloFalso(), 5)).toMatchObject({ reivindicados: 1, concluidas: 1 });

    const res = await rotaComo(ORG_A, DONO_A, ['organization:access'])(new Request(`https://orbita.test/api/sac/triagem?conversaId=${conversa}`));
    expect(res.status).toBe(200);
    const corpo = await res.json();
    expect(corpo.caso.execucao).toMatchObject({ status: 'concluida', provedor: 'fake', modelo: 'falso-v1' });
    expect(corpo.caso.execucao.triagem.precisaDeHumano).toBe(true);
    expect((await rotaComo(ORG_B, DONO_B, ['organization:access'])(new Request(`https://orbita.test/api/sac/triagem?conversaId=${conversa}`))).status).toBe(404);
    expect((await rotaComo(ORG_A, DONO_A, [])(new Request(`https://orbita.test/api/sac/triagem?conversaId=${conversa}`))).status).toBe(403);
  });

  it('429 do provedor: volta à fila com espera de pelo menos 60 s, sem resultado inventado', async () => {
    await congelarTriagensPendentes();
    const conversa = await mensagemDoContato(ORG_A, CONEXAO_A, 1321, 132, '2026-11-16T10:02:00Z');
    expect(await passada(roteirizado([{ _tag: 'Limite', repetirEmSegundos: null }]), 5)).toMatchObject({ reivindicados: 1, falhas: 1 });
    const { rows: [evento] } = await admin.query(
      `select o.status, o.last_error_category, extract(epoch from (o.next_retry_at - now()))::int as espera
         from public.outbox_eventos o join public.sac_cases s on s.id::text = o.payload ->> 'caso_id'
        where s.conversa_id_local = $1 and o.destination = 'interno'`, [conversa]);
    expect(evento).toMatchObject({ status: 'failed_transient', last_error_category: 'rate_limit' });
    expect(evento.espera).toBeGreaterThanOrEqual(55);
    const lida = await lerTriagemDoCaso(cliente, escopo(ORG_A, DONO_A), conversa);
    expect(lida._tag === 'Lida' && lida.caso).toMatchObject({ pendente: true, execucao: { status: 'falha', motivo: 'limite_do_provedor', triagem: null } });
  });

  it('mensagem nova antes do início: a triagem antiga vira obsoleta sem chamar o modelo, e a nova é a que vale', async () => {
    await congelarTriagensPendentes();
    const conversa = await mensagemDoContato(ORG_A, CONEXAO_A, 1331, 133, '2026-11-16T10:03:00Z');
    await mensagemDoContato(ORG_A, CONEXAO_A, 1332, 133, '2026-11-16T10:04:00Z');
    const falso = criarModeloFalso();
    const gerar = vi.fn(falso.gerar);
    const resumo = await passada({ ...falso, gerar }, 5);
    expect(resumo).toMatchObject({ reivindicados: 2, encerradas: 1, concluidas: 1 });
    expect(gerar).toHaveBeenCalledTimes(1);
    const lida = await lerTriagemDoCaso(cliente, escopo(ORG_A, DONO_A), conversa);
    expect(lida._tag === 'Lida' && lida.caso?.execucao?.status).toBe('concluida');
  });

  it('os logs do worker não levam o texto da cliente nem os campos livres do resultado', async () => {
    await congelarTriagensPendentes();
    const linhas: string[] = [];
    for (const nivel of ['info', 'warn', 'error'] as const) {
      vi.spyOn(logger, nivel).mockImplementation((mensagem: string, contexto?: unknown) => { linhas.push(`${mensagem} ${JSON.stringify(contexto ?? {})}`); });
    }
    await mensagemDoContato(ORG_A, CONEXAO_A, 1341, 134, '2026-11-16T10:05:00Z');
    await passada(criarModeloFalso(), 5);
    expect(linhas.length).toBeGreaterThan(0);
    const log = linhas.join('\n');
    // O texto da cliente e os campos livres da triagem (motivo, motivo do humano) ficam fora;
    // desfecho, tokens e o booleano de handoff são métricas operacionais, sem conteúdo.
    expect(log).not.toMatch(/TEXTO-SINTETICO|pedido 1001|modelo falso: nenhuma IA|atendente precisa ler/iu);
    expect(log).toContain('sac.triagem.concluida');
  });
});
