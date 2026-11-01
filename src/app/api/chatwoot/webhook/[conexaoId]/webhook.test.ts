import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project-ref.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'public-key-12345678901234567890';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'server-key-12345678901234567890';
process.env.ENCRYPTION_KEY = 'ab'.repeat(32);

import { encrypt } from '@/lib/crypto';
import type { EspelhoChatwootFake } from '@/services/__testkit__/espelhoChatwootFake';

/** Espelhos em memória com as regras do banco (PK global até o MSG-004). */
const espelho = vi.hoisted(() => ({ store: null as unknown as EspelhoChatwootFake }));
vi.mock('@/services/chatwoot/espelhoChatwootSupabase', async () => {
  const { EspelhoChatwootFake: Fake } = await import('@/services/__testkit__/espelhoChatwootFake');
  espelho.store = new Fake();
  return { criarEspelhoChatwootSupabase: () => espelho.store };
});

const ORG_A = '22222222-2222-4222-8222-222222222222';
const ORG_B = '33333333-3333-4333-8333-333333333333';
const CONEXAO_A = '11111111-1111-4111-8111-111111111111';
const CONEXAO_B = '44444444-4444-4444-8444-444444444444';
/** Organização cujo owner perdeu o acesso: nenhuma membership de owner resolve. */
const ORG_SEM_DONO = '55555555-5555-4555-8555-555555555555';
const CONEXAO_SEM_DONO = '66666666-6666-4666-8666-666666666666';
const SECRET_SEM_DONO = 'chatwoot_secret_org_sem_dono_1234';
const OWNER_A = '70000000-0000-4000-8000-000000000001';
const OWNER_B = '70000000-0000-4000-8000-000000000002';
const SECRET_A = 'chatwoot_secret_org_a_1234567890';
const SECRET_B = 'chatwoot_secret_org_b_1234567890';

let connections: Record<string, { organizacao_id: string; status: string }> = {};
let credentials: Record<string, string> = {};
const inboxLookups: Array<{ conexao_id: string; inbox_id: number; organizacao_id: string }> = [];
const insertedInboxRows: unknown[] = [];
const mockUpsert = vi.fn().mockResolvedValue({ error: null });
const mockUpdate = vi.fn().mockReturnValue({
  eq: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
});

let mockInboxRegisterResult = {
  evento_id: 'evt-1',
  status: 'received',
  is_duplicate: false,
  cached_response: null as Record<string, unknown> | null,
};

/** Desfecho do contador de limite por conexão; `null` simula o store fora do ar. */
let limitePermite: boolean | null = true;

/**
 * Inbox fiel (MSG-005): mesma regra da função `aceitar_entrega_inbox_chatwoot`
 * — evento único por conexão + chave, entrega única por conexão + delivery id,
 * delivery id reaproveitado com outra chave recusado sem gravar nada.
 */
const inboxFiel = {
  ligada: false,
  falha: null as { code: string; message: string } | null,
  eventos: new Map<string, { id: string; chave: string; status: string; response_body: Record<string, unknown> | null }>(),
  entregas: new Map<string, string>(),
  aceitar(args: Record<string, unknown>) {
    if (this.falha) return { data: null, error: this.falha };
    const conexao = String(args.p_conexao_id);
    const chave = String(args.p_idempotency_key);
    const existente = this.eventos.get(`${conexao}|${chave}`);
    let duplicata: 'entrega' | 'evento' | null = existente ? 'evento' : null;
    if (args.p_delivery_id) {
      const anterior = this.entregas.get(`${conexao}|${String(args.p_delivery_id)}`);
      if (anterior !== undefined && anterior !== chave) return { data: null, error: { code: '23505', message: 'reutilizado' } };
      if (anterior !== undefined) duplicata = 'entrega';
      this.entregas.set(`${conexao}|${String(args.p_delivery_id)}`, chave);
    }
    const evento = existente ?? { id: `evt-fiel-${this.eventos.size + 1}`, chave, status: 'received', response_body: null };
    this.eventos.set(`${conexao}|${chave}`, evento);
    return {
      data: [{ evento_id: evento.id, status: evento.status, is_duplicate: duplicata !== null, duplicata, cached_response: evento.response_body }],
      error: null,
    };
  },
  concluir(args: Record<string, unknown>) {
    const evento = [...this.eventos.values()].find((e) => e.id === args.p_evento_id);
    if (evento) {
      evento.status = String(args.p_status);
      if (args.p_status === 'processed') evento.response_body = args.p_response_body as Record<string, unknown>;
    }
  },
};

const mockRpc = vi.fn().mockImplementation((fnName: string, args: Record<string, unknown>) => {
  if (inboxFiel.ligada && fnName === 'aceitar_entrega_inbox_chatwoot') return Promise.resolve(inboxFiel.aceitar(args));
  if (inboxFiel.ligada && fnName === 'concluir_evento_inbox_chatwoot') {
    inboxFiel.concluir(args);
    return Promise.resolve({ data: null, error: null });
  }
  if (fnName === 'aceitar_entrega_inbox_chatwoot') {
    const duplicata = mockInboxRegisterResult.is_duplicate ? 'evento' : null;
    return Promise.resolve({ data: [{ ...mockInboxRegisterResult, duplicata }], error: null });
  }
  if (fnName === 'registrar_tentativa_limite_taxa') {
    if (limitePermite === null) return Promise.resolve({ data: null, error: { message: 'connection refused' } });
    return Promise.resolve({ data: [{ permitido: limitePermite, contagem: 1, reset_em: new Date(Date.now() + 60_000).toISOString() }], error: null });
  }
  if (fnName === 'concluir_evento_inbox_chatwoot') {
    return Promise.resolve({ data: null, error: null });
  }
  return Promise.resolve({ data: null, error: null });
});

vi.mock('@/lib/supabaseServer', () => ({
  supabaseServer: {
    rpc: (...args: unknown[]) => mockRpc(...(args as [string, Record<string, unknown>])),
    from: (table: string) => {
      if (table === 'conexoes_integracao') {
        return {
          select: () => ({
            eq: (col: string, val: string) => ({
              eq: () => ({
                maybeSingle: () => {
                  const conn = connections[val];
                  return Promise.resolve({ data: conn ? { id: val, ...conn } : null, error: null });
                },
              }),
            }),
          }),
        };
      }
      if (table === 'credenciais_integracao') {
        return {
          select: () => ({
            eq: () => ({
              eq: (_col2: string, conexaoId: string) => ({
                maybeSingle: () => {
                  const cipher = credentials[conexaoId];
                  return Promise.resolve({
                    data: cipher ? { dados_cifrados: cipher, chave_versao: 'v1' } : null,
                    error: null,
                  });
                },
              }),
            }),
          }),
        };
      }
      if (table === 'membros_organizacao') {
        return {
          select: () => ({
            eq: (_col: string, orgId: string) => ({
              eq: () => ({
                limit: () => ({
                  maybeSingle: () => {
                    const owner = orgId === ORG_A ? OWNER_A : orgId === ORG_B ? OWNER_B : null;
                    return Promise.resolve({ data: owner ? { user_id: owner } : null, error: null });
                  },
                }),
                maybeSingle: () => Promise.resolve({ data: { papel: 'owner' }, error: null }),
              }),
            }),
          }),
        };
      }
      if (table === 'chatwoot_inboxes') {
        return {
          select: () => ({
            eq: (_c: string, conexaoId: string) => ({
              eq: (_c2: string, inboxId: number) => ({
                maybeSingle: () => {
                  const found = inboxLookups.find((r) => r.conexao_id === conexaoId && r.inbox_id === inboxId);
                  return Promise.resolve({ data: found ? { id: 'row', organizacao_id: found.organizacao_id } : null, error: null });
                },
              }),
            }),
          }),
          insert: (row: Record<string, unknown>) => {
            insertedInboxRows.push(row);
            inboxLookups.push({
              conexao_id: row.conexao_id as string,
              inbox_id: row.inbox_id as number,
              organizacao_id: row.organizacao_id as string,
            });
            return Promise.resolve({ error: null });
          },
        };
      }
      if (table === 'inbox_eventos_chatwoot') {
        return {
          select: () => ({
            eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { id: 'evt-1' }, error: null }) }) }),
          }),
        };
      }
      return { upsert: mockUpsert, update: mockUpdate };
    },
  },
}));

function signBody(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)): { signature: string; timestamp: string } {
  const hex = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return { signature: `sha256=${hex}`, timestamp: String(timestamp) };
}

describe('Chatwoot per-connection webhook: security and idempotent inbox', () => {
  beforeAll(() => {
    connections = {
      [CONEXAO_A]: { organizacao_id: ORG_A, status: 'conectado' },
      [CONEXAO_B]: { organizacao_id: ORG_B, status: 'conectado' },
      [CONEXAO_SEM_DONO]: { organizacao_id: ORG_SEM_DONO, status: 'conectado' },
    };
    credentials = {
      [CONEXAO_A]: encrypt(
        JSON.stringify({ api_url: 'https://a.chatwoot.test', api_token: 'tok-a', account_id: '1', webhook_secret: SECRET_A }),
      ) as string,
      [CONEXAO_B]: encrypt(
        JSON.stringify({ api_url: 'https://b.chatwoot.test', api_token: 'tok-b', account_id: '1', webhook_secret: SECRET_B }),
      ) as string,
      [CONEXAO_SEM_DONO]: encrypt(
        JSON.stringify({ api_url: 'https://c.chatwoot.test', api_token: 'tok-c', account_id: '1', webhook_secret: SECRET_SEM_DONO }),
      ) as string,
    };
  });

  async function postWebhook(
    conexaoId: string,
    body: string,
    headers?: { signature?: string; timestamp?: string },
  ) {
    const { POST } = await import('./route');
    const reqHeaders: Record<string, string> = {};
    if (headers?.signature) reqHeaders['x-chatwoot-signature'] = headers.signature;
    if (headers?.timestamp) reqHeaders['x-chatwoot-timestamp'] = headers.timestamp;
    const req = new Request(`https://orbita.test/api/chatwoot/webhook/${conexaoId}`, {
      method: 'POST',
      headers: reqHeaders,
      body,
    });
    return POST(req, { params: Promise.resolve({ conexaoId }) });
  }

  it('rejects an unknown connection id', async () => {
    const body = JSON.stringify({ event: 'message_created', account: { id: 1 } });
    const { signature, timestamp } = signBody('irrelevant-secret', body);
    const res = await postWebhook('99999999-9999-4999-8999-999999999999', body, { signature, timestamp });
    expect(res.status).toBe(404);
  });

  it('rejects a request without a signature header (fail-closed)', async () => {
    const body = JSON.stringify({ event: 'message_created', account: { id: 1 } });
    const res = await postWebhook(CONEXAO_A, body);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ success: false, error: 'Assinatura ausente' });
  });

  it('rejects an invalid/tampered signature', async () => {
    const body = JSON.stringify({ event: 'message_created', account: { id: 1 } });
    const res = await postWebhook(CONEXAO_A, body, {
      signature: 'sha256=not-a-real-signature-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      timestamp: String(Math.floor(Date.now() / 1000)),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ success: false, error: 'Assinatura inválida' });
  });

  it('rejects a payload that does not match the Chatwoot webhook schema', async () => {
    const body = JSON.stringify({ notEvent: true });
    const { signature, timestamp } = signBody(SECRET_A, body);
    const res = await postWebhook(CONEXAO_A, body, { signature, timestamp });
    expect(res.status).toBe(400);
  });

  it('rejects when the payload account_id does not match the connection', async () => {
    const body = JSON.stringify({
      event: 'message_created',
      account: { id: 999 },
      id: 1,
      inbox: { id: 10 },
      conversation: { id: 20 },
    });
    const { signature, timestamp } = signBody(SECRET_A, body);
    const res = await postWebhook(CONEXAO_A, body, { signature, timestamp });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ success: false, error: 'Conta Chatwoot não corresponde à conexão' });
  });

  it('rejects a side-effecting event with no resolvable inbox_id', async () => {
    const body = JSON.stringify({ event: 'message_created', account: { id: 1 }, id: 1, conversation: {} });
    const { signature, timestamp } = signBody(SECRET_A, body);
    const res = await postWebhook(CONEXAO_A, body, { signature, timestamp });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ success: false, error: 'Inbox não identificada' });
  });

  it('PRE-008: conexão desligada recusa a entrega assinada, sem mapping, inbox nem efeito', async () => {
    connections[CONEXAO_A]!.status = 'desconectado';
    mockUpsert.mockClear();
    mockRpc.mockClear();
    const inboxesAntes = insertedInboxRows.length;
    try {
      const body = JSON.stringify({
        event: 'message_created',
        account: { id: 1 },
        id: 502,
        content: 'mensagem depois de desligar',
        inbox: { id: 7 },
        conversation: { id: 207, inbox_id: 7, contact: { id: 107 } },
        sender: { id: 107, type: 'contact' },
      });
      const { signature, timestamp } = signBody(SECRET_A, body);
      const res = await postWebhook(CONEXAO_A, body, { signature, timestamp });

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ success: false, error: 'Conexão Chatwoot desligada' });
      expect(insertedInboxRows).toHaveLength(inboxesAntes);
      expect(mockRpc).not.toHaveBeenCalled();
      expect(espelho.store?.chamadas ?? []).toHaveLength(0);
    } finally {
      connections[CONEXAO_A]!.status = 'conectado';
    }
  });

  it('PRE-008: owner removido — a entrega assinada é recusada sem mapping, inbox nem efeito', async () => {
    mockUpsert.mockClear();
    mockRpc.mockClear();
    const inboxesAntes = insertedInboxRows.length;
    const erro = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const body = JSON.stringify({
        event: 'message_created',
        account: { id: 1 },
        id: 503,
        inbox: { id: 9 },
        conversation: { id: 209, inbox_id: 9, contact: { id: 109 } },
        sender: { id: 109, type: 'contact' },
      });
      const { signature, timestamp } = signBody(SECRET_SEM_DONO, body);
      const res = await postWebhook(CONEXAO_SEM_DONO, body, { signature, timestamp });

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ success: false, error: 'Escopo organizacional inválido' });
      expect(insertedInboxRows).toHaveLength(inboxesAntes);
      // Só o contador de limite (depois da assinatura); nenhuma escrita na inbox.
      expect(mockRpc.mock.calls.map(([fn]) => fn)).toEqual(['registrar_tentativa_limite_taxa']);
      expect(espelho.store?.chamadas ?? []).toHaveLength(0);
    } finally {
      erro.mockRestore();
    }
  });

  it('PRE-008: conexão desligada com assinatura inválida responde 401, sem revelar o estado', async () => {
    connections[CONEXAO_A]!.status = 'desconectado';
    try {
      const body = JSON.stringify({ event: 'message_created', account: { id: 1 } });
      const { signature, timestamp } = signBody('segredo-errado', body);
      const res = await postWebhook(CONEXAO_A, body, { signature, timestamp });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ success: false, error: 'Assinatura inválida' });
    } finally {
      connections[CONEXAO_A]!.status = 'conectado';
    }
  });

  it('processes a valid signed event, auto-registers the inbox mapping and marks it processed', async () => {
    mockInboxRegisterResult = { evento_id: 'evt-a1', status: 'received', is_duplicate: false, cached_response: null };
    mockUpsert.mockClear();
    mockRpc.mockClear();

    const body = JSON.stringify({
      event: 'message_created',
      account: { id: 1 },
      id: 501,
      content: 'Olá atendente',
      message_type: 'incoming',
      inbox: { id: 1 },
      conversation: {
        id: 201,
        display_id: 1,
        inbox_id: 1,
        status: 'open',
        contact: { id: 101, name: 'Cliente A', phone_number: '+5511999990001' },
      },
      sender: { id: 101, name: 'Cliente A', type: 'contact' },
    });

    const { signature: sigA, timestamp: tsA } = signBody(SECRET_A, body);
    const res = await postWebhook(CONEXAO_A, body, { signature: sigA, timestamp: tsA });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(insertedInboxRows).toContainEqual(
      expect.objectContaining({ organizacao_id: ORG_A, conexao_id: CONEXAO_A, inbox_id: 1, account_id: '1' }),
    );
    const contato = espelho.store.linhas.contato.find((l) => l.organizacao_id === ORG_A && l.id_externo === '101');
    const conversa = espelho.store.linhas.conversa.find((l) => l.organizacao_id === ORG_A && l.id_externo === '201');
    const mensagem = espelho.store.linhas.mensagem.find((l) => l.organizacao_id === ORG_A && l.id_externo === '501');
    expect(contato).toMatchObject({ conexao_id: CONEXAO_A, user_id: OWNER_A });
    expect(conversa).toMatchObject({ conexao_id: CONEXAO_A, contato_id_local: contato!.id_local });
    expect(mensagem).toMatchObject({ conexao_id: CONEXAO_A, conversa_id_local: conversa!.id_local, content: 'Olá atendente' });
    // O inbox guarda o desfecho pelo UUID local; o id remoto não sai do adapter/resolver.
    expect(mockRpc).toHaveBeenCalledWith(
      'concluir_evento_inbox_chatwoot',
      expect.objectContaining({
        p_evento_id: 'evt-a1',
        p_status: 'processed',
        p_response_body: expect.objectContaining({
          contatoIdLocal: contato!.id_local,
          conversaIdLocal: conversa!.id_local,
          mensagemIdLocal: mensagem!.id_local,
        }),
      }),
    );
  });

  it('keeps organization A and B fully isolated when both use inbox_id=1 (overlapping external ids)', async () => {
    mockUpsert.mockClear();

    mockInboxRegisterResult = { evento_id: 'evt-b1', status: 'received', is_duplicate: false, cached_response: null };
    const bodyB = JSON.stringify({
      event: 'message_created',
      account: { id: 1 },
      id: 777,
      content: 'Mensagem da organização B',
      message_type: 'incoming',
      inbox: { id: 1 },
      conversation: {
        id: 999,
        inbox_id: 1,
        status: 'open',
        contact: { id: 555, name: 'Cliente B', phone_number: '+5511888880000' },
      },
      sender: { id: 555, name: 'Cliente B', type: 'contact' },
    });

    const { signature: sigB, timestamp: tsB } = signBody(SECRET_B, bodyB);
    const res = await postWebhook(CONEXAO_B, bodyB, { signature: sigB, timestamp: tsB });
    expect(res.status).toBe(200);

    // Org A's earlier inbox_id=1 registration and Org B's inbox_id=1 registration
    // are both present, scoped to their own connection/organization, never merged.
    expect(inboxLookups.filter((r) => r.inbox_id === 1)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ conexao_id: CONEXAO_A, organizacao_id: ORG_A }),
        expect.objectContaining({ conexao_id: CONEXAO_B, organizacao_id: ORG_B }),
      ]),
    );
    expect(espelho.store.linhas.contato.filter((l) => l.id_externo === '555')).toEqual([
      expect.objectContaining({ organizacao_id: ORG_B, conexao_id: CONEXAO_B }),
    ]);
  });

  it('replays a duplicate delivery as a no-op, returning the cached response without new side effects', async () => {
    mockUpsert.mockClear();
    mockInboxRegisterResult = {
      evento_id: 'evt-a1',
      status: 'processed',
      is_duplicate: true,
      cached_response: { success: true, cached: true },
    };

    const body = JSON.stringify({
      event: 'message_created',
      account: { id: 1 },
      id: 501,
      inbox: { id: 1 },
      conversation: { id: 201, inbox_id: 1 },
    });

    const { signature, timestamp } = signBody(SECRET_A, body);
    const res = await postWebhook(CONEXAO_A, body, { signature, timestamp });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, cached: true });
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(espelho.store.linhas.mensagem.filter((l) => l.id_externo === '501')).toHaveLength(1);
  });

  describe('MSG-003A: identidade local por organização + conexão', () => {
    function evento(extra: Record<string, unknown>) {
      return JSON.stringify({ event: 'message_created', account: { id: 1 }, inbox: { id: 1 }, ...extra });
    }
    async function entregar(conexaoId: string, segredo: string, body: string, eventoId: string, status = 'received') {
      mockInboxRegisterResult = { evento_id: eventoId, status, is_duplicate: status !== 'received', cached_response: null };
      const { signature, timestamp } = signBody(segredo, body);
      return postWebhook(conexaoId, body, { signature, timestamp });
    }
    const conclusao = (eventoId: string) => mockRpc.mock.calls
      .filter(([fn, args]) => fn === 'concluir_evento_inbox_chatwoot' && (args as { p_evento_id: string }).p_evento_id === eventoId)
      .map(([, args]) => args as { p_status: string; p_error: string | null; p_response_body: Record<string, unknown> | null });

    it('B com os mesmos ids remotos de A grava a sua árvore (MSG-004): uma linha por instalação, A intacta', async () => {
      mockRpc.mockClear();
      const conversa = { id: 802, inbox_id: 1, status: 'open', contact: { id: 801, name: 'Cliente A 801' } };
      expect((await entregar(CONEXAO_A, SECRET_A, evento({ id: 803, content: 'de A', conversation: conversa }), 'evt-803a'))
        .status).toBe(200);
      const res = await entregar(CONEXAO_B, SECRET_B, evento({
        id: 803, content: 'de B', conversation: { ...conversa, contact: { id: 801, name: 'Cliente B 801' } },
      }), 'evt-803b');
      expect(res.status).toBe(200);
      expect(conclusao('evt-803b')).toEqual([expect.objectContaining({ p_status: 'processed' })]);
      for (const recurso of ['contato', 'conversa', 'mensagem'] as const) {
        const linhas = espelho.store.linhas[recurso].filter((l) => ['801', '802', '803'].includes(l.id_externo));
        expect(linhas).toHaveLength(2);
        expect(linhas).toEqual(expect.arrayContaining([
          expect.objectContaining({ organizacao_id: ORG_A, conexao_id: CONEXAO_A }),
          expect.objectContaining({ organizacao_id: ORG_B, conexao_id: CONEXAO_B }),
        ]));
      }
      const contatoDe = (conexao: string) => espelho.store.linhas.contato.find((l) => l.id_externo === '801' && l.conexao_id === conexao)!;
      expect(contatoDe(CONEXAO_A).name).toBe('Cliente A 801');
      expect(contatoDe(CONEXAO_B).name).toBe('Cliente B 801');
      // A mensagem de B entra na conversa 802 de B, nunca na de A.
      const conversaDe = (conexao: string) => espelho.store.linhas.conversa.find((l) => l.id_externo === '802' && l.conexao_id === conexao)!;
      const mensagemDe = (conexao: string) => espelho.store.linhas.mensagem.find((l) => l.id_externo === '803' && l.conexao_id === conexao)!;
      expect(mensagemDe(CONEXAO_B)).toMatchObject({ conversa_id_local: conversaDe(CONEXAO_B).id_local, content: 'de B' });
      expect(mensagemDe(CONEXAO_A)).toMatchObject({ conversa_id_local: conversaDe(CONEXAO_A).id_local, content: 'de A' });
    });

    it('mensagem antes da conversa: 409 PaiNaoEspelhado sem gravar; o reprocessamento grava uma vez', async () => {
      mockRpc.mockClear();
      const cedo = evento({ id: 913, content: 'chegou cedo', conversation: { id: 912, inbox_id: 1 } });
      const res = await entregar(CONEXAO_A, SECRET_A, cedo, 'evt-913');
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ motivo: 'PaiNaoEspelhado' });
      expect(espelho.store.linhas.mensagem.filter((l) => l.id_externo === '913')).toHaveLength(0);
      expect(conclusao('evt-913')).toEqual([expect.objectContaining({ p_status: 'failed' })]);

      const conversa = { id: 912, inbox_id: 1, status: 'open', contact: { id: 911, name: 'Cliente 911' } };
      expect((await entregar(CONEXAO_A, SECRET_A, evento({ id: 914, content: 'abre a conversa', conversation: conversa }), 'evt-914')).status).toBe(200);

      // A mesma entrega volta (falhou antes): o inbox a reprocessa.
      expect((await entregar(CONEXAO_A, SECRET_A, cedo, 'evt-913', 'failed')).status).toBe(200);
      expect((await entregar(CONEXAO_A, SECRET_A, cedo, 'evt-913', 'failed')).status).toBe(200);
      const mensagens = espelho.store.linhas.mensagem.filter((l) => l.id_externo === '913');
      expect(mensagens).toHaveLength(1);
      expect(mensagens[0]).toMatchObject({ conexao_id: CONEXAO_A, content: 'chegou cedo' });
    });

    it('message_updated antes de message_created: a criação atrasada não desfaz a edição', async () => {
      const conversa = { id: 922, inbox_id: 1, status: 'open', contact: { id: 921, name: 'Cliente 921' } };
      await entregar(CONEXAO_A, SECRET_A, evento({ event: 'message_updated', id: 923, content: 'editada', conversation: conversa }), 'evt-923u');
      await entregar(CONEXAO_A, SECRET_A, evento({ id: 923, content: 'original', conversation: conversa }), 'evt-923c');
      expect(espelho.store.linhas.mensagem.filter((l) => l.id_externo === '923')).toEqual([expect.objectContaining({ content: 'editada' })]);
    });

    it('revisão: status para conversa legada sem conexão comprovada não a altera e registra conexao_nao_comprovada', async () => {
      mockRpc.mockClear();
      const contato = espelho.store.semear('contato', { id: 931, organizacao_id: ORG_A, conexao_id: null, name: 'legado' });
      espelho.store.semear('conversa', { id: 930, organizacao_id: ORG_A, conexao_id: null, contact_id: 931, contato_id_local: contato, status: 'open' });
      const body = JSON.stringify({
        event: 'conversation_status_changed', account: { id: 1 }, inbox: { id: 1 }, conversation: { id: 930, inbox_id: 1, status: 'resolved' },
      });
      expect((await entregar(CONEXAO_A, SECRET_A, body, 'evt-status-legado')).status).toBe(200);
      expect(espelho.store.linhas.conversa.find((l) => l.id_externo === '930')).toMatchObject({ conexao_id: null, status: 'open' });
      expect(conclusao('evt-status-legado')).toEqual([expect.objectContaining({
        p_status: 'processed', p_response_body: expect.objectContaining({ ignorado: 'conexao_nao_comprovada' }),
      })]);
    });

    it('status de B na conversa 802 muda só a de B; numa conversa que B não tem, registra conversa_nao_espelhada', async () => {
      mockRpc.mockClear();
      const status = (id: number) => JSON.stringify({
        event: 'conversation_status_changed', account: { id: 1 }, inbox: { id: 1 }, conversation: { id, inbox_id: 1, status: 'resolved' },
      });
      const conversaDe = (id: string, conexao: string) => espelho.store.linhas.conversa.find((l) => l.id_externo === id && l.conexao_id === conexao)!;

      expect((await entregar(CONEXAO_B, SECRET_B, status(802), 'evt-status-b')).status).toBe(200);
      expect(conversaDe('802', CONEXAO_B).status).toBe('resolved');
      expect(conversaDe('802', CONEXAO_A).status).toBe('open');
      expect(conclusao('evt-status-b')).toEqual([expect.objectContaining({
        p_response_body: expect.objectContaining({ conversaIdLocal: conversaDe('802', CONEXAO_B).id_local }),
      })]);

      // A conversa 912 só existe em A.
      expect((await entregar(CONEXAO_B, SECRET_B, status(912), 'evt-status-b-912')).status).toBe(200);
      expect(conversaDe('912', CONEXAO_A).status).toBe('open');
      expect(conclusao('evt-status-b-912')).toEqual([expect.objectContaining({
        p_status: 'processed', p_response_body: expect.objectContaining({ ignorado: 'conversa_nao_espelhada' }),
      })]);

      expect((await entregar(CONEXAO_A, SECRET_A, status(802), 'evt-status-a')).status).toBe(200);
      expect(conversaDe('802', CONEXAO_A).status).toBe('resolved');
      expect(conclusao('evt-status-a')).toEqual([expect.objectContaining({
        p_response_body: expect.objectContaining({ conversaIdLocal: conversaDe('802', CONEXAO_A).id_local }),
      })]);
    });
  });
});

describe('MSG-005: aceite na inbox com dedup de entrega e revisão antes do ACK', () => {
  const CONVERSA = { id: 960, inbox_id: 1, status: 'open', contact: { id: 961, name: 'Cliente 961' } };

  function corpo(extra: Record<string, unknown>): string {
    return JSON.stringify({ event: 'message_created', account: { id: 1 }, inbox: { id: 1 }, conversation: CONVERSA, ...extra });
  }

  async function entregar(
    body: string | Buffer,
    opcoes: { delivery?: string; segredo?: string; conexao?: string; timestamp?: number; corpoAssinado?: string | Buffer } = {},
  ) {
    const { POST } = await import('./route');
    const timestamp = String(opcoes.timestamp ?? Math.floor(Date.now() / 1000));
    const assinado = opcoes.corpoAssinado ?? body;
    const hex = crypto.createHmac('sha256', opcoes.segredo ?? SECRET_A).update(`${timestamp}.`).update(assinado).digest('hex');
    const headers: Record<string, string> = { 'x-chatwoot-signature': `sha256=${hex}`, 'x-chatwoot-timestamp': timestamp };
    if (opcoes.delivery) headers['x-chatwoot-delivery'] = opcoes.delivery;
    const conexaoId = opcoes.conexao ?? CONEXAO_A;
    const req = new Request(`https://orbita.test/api/chatwoot/webhook/${conexaoId}`, { method: 'POST', headers, body: typeof body === 'string' ? body : new Uint8Array(body) });
    return POST(req, { params: Promise.resolve({ conexaoId }) });
  }

  const chamadas = (fn: string) => mockRpc.mock.calls.filter(([nome]) => nome === fn).map(([, args]) => args as Record<string, unknown>);
  const mensagens = (id: string) => espelho.store.linhas.mensagem.filter((l) => l.id_externo === id && l.conexao_id === CONEXAO_A);

  beforeEach(() => {
    inboxFiel.ligada = true;
    inboxFiel.falha = null;
    inboxFiel.eventos.clear();
    inboxFiel.entregas.clear();
    limitePermite = true;
    mockRpc.mockClear();
  });
  afterEach(() => {
    inboxFiel.ligada = false;
    limitePermite = true;
  });

  it('o mesmo delivery id várias vezes: um evento, efeito uma vez, resposta gravada nas repetições', async () => {
    const body = corpo({ id: 9601, content: 'primeira' });
    const respostas = [];
    for (let i = 0; i < 3; i += 1) respostas.push(await entregar(body, { delivery: 'del-9601' }));
    expect(respostas.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(inboxFiel.eventos.size).toBe(1);
    expect(mensagens('9601')).toHaveLength(1);
    expect(chamadas('concluir_evento_inbox_chatwoot')).toHaveLength(1);
  });

  it('ACK perdido: a reentrega devolve o resultado gravado e não repete o efeito', async () => {
    const body = corpo({ id: 9602, content: 'ack perdido' });
    expect((await entregar(body, { delivery: 'del-9602' })).status).toBe(200);
    const efeitosAntes = espelho.store.chamadas.length;
    const reentrega = await entregar(body, { delivery: 'del-9602', timestamp: Math.floor(Date.now() / 1000) + 30 });
    expect(reentrega.status).toBe(200);
    expect(await reentrega.json()).toMatchObject({ success: true, event: 'message_created' });
    expect(espelho.store.chamadas.length).toBe(efeitosAntes);
  });

  it('entrega sem delivery id: aceita; o message_created repetido é deduplicado pela identidade lógica', async () => {
    const body = corpo({ id: 9603, content: 'sem id de entrega' });
    expect((await entregar(body)).status).toBe(200);
    expect((await entregar(body, { timestamp: Math.floor(Date.now() / 1000) + 5 })).status).toBe(200);
    expect(chamadas('aceitar_entrega_inbox_chatwoot').map((a) => a.p_delivery_id)).toEqual([null, null]);
    expect(inboxFiel.eventos.size).toBe(1);
    expect(mensagens('9603')).toHaveLength(1);
  });

  it('message_created duplicado em entregas diferentes: um evento', async () => {
    const body = corpo({ id: 9604, content: 'criada' });
    await entregar(body, { delivery: 'del-9604-a' });
    await entregar(body, { delivery: 'del-9604-b' });
    expect(inboxFiel.eventos.size).toBe(1);
  });

  it('message_updated com duas revisões: as duas são aceitas e a última prevalece no espelho', async () => {
    await entregar(corpo({ id: 9605, content: 'v0' }), { delivery: 'del-9605-c' });
    await entregar(corpo({ event: 'message_updated', id: 9605, content: 'v1' }), { delivery: 'del-9605-u1' });
    await entregar(corpo({ event: 'message_updated', id: 9605, content: 'v2' }), { delivery: 'del-9605-u2' });
    // A volta ao conteúdo anterior também é revisão legítima.
    await entregar(corpo({ event: 'message_updated', id: 9605, content: 'v1' }), { delivery: 'del-9605-u3' });
    expect(inboxFiel.eventos.size).toBe(4);
    expect(mensagens('9605')).toEqual([expect.objectContaining({ content: 'v1' })]);
  });

  it('status repetido separado por outras transições: open → resolved → open → resolved, quatro ocorrências processadas', async () => {
    await entregar(corpo({ id: 9606, content: 'abre' }), { delivery: 'del-9606' });
    const sequencia = ['open', 'resolved', 'open', 'resolved'];
    for (const [i, status] of sequencia.entries()) {
      const body = JSON.stringify({
        event: 'conversation_status_changed', account: { id: 1 }, inbox: { id: 1 }, conversation: { ...CONVERSA, status },
      });
      expect((await entregar(body, { delivery: `del-9606-s${i}` })).status).toBe(200);
    }
    const eventosDeStatus = [...inboxFiel.eventos.values()].filter((e) => e.chave.startsWith('v2:conversation_status_changed'));
    expect(eventosDeStatus).toHaveLength(4);
    expect(eventosDeStatus.every((e) => e.status === 'processed')).toBe(true);
    expect(espelho.store.linhas.conversa.find((l) => l.id_externo === '960' && l.conexao_id === CONEXAO_A)?.status).toBe('resolved');
  });

  it('fora de ordem: a segunda edição chega antes da primeira e as duas ficam na inbox', async () => {
    await entregar(corpo({ id: 9607, content: 'base' }), { delivery: 'del-9607-c' });
    expect((await entregar(corpo({ event: 'message_updated', id: 9607, content: 'r2', updated_at: '2026-10-27T10:00:02Z' }),
      { delivery: 'del-9607-r2' })).status).toBe(200);
    expect((await entregar(corpo({ event: 'message_updated', id: 9607, content: 'r1', updated_at: '2026-10-27T10:00:01Z' }),
      { delivery: 'del-9607-r1' })).status).toBe(200);
    expect([...inboxFiel.eventos.values()].filter((e) => e.chave.includes(':msg:9607:'))).toHaveLength(2);
  });

  it('delivery id reaproveitado com outro evento: 409 e nada gravado', async () => {
    await entregar(corpo({ id: 9609, content: 'um' }), { delivery: 'del-9609' });
    const res = await entregar(corpo({ id: 9610, content: 'outro' }), { delivery: 'del-9609' });
    expect(res.status).toBe(409);
    expect(inboxFiel.eventos.size).toBe(1);
    expect(mensagens('9610')).toHaveLength(0);
  });

  it('falha do banco antes do commit: não-2xx, sem mapping, efeito nem conclusão; a reentrega depois grava', async () => {
    inboxFiel.falha = { code: '08006', message: 'connection failure host=db.interno' };
    const mapeamentosAntes = insertedInboxRows.length;
    const body = corpo({ id: 9611, content: 'banco fora', inbox: { id: 61 }, conversation: { ...CONVERSA, id: 9611, inbox_id: 61 } });
    const res = await entregar(body, { delivery: 'del-9611' });
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).not.toContain('db.interno');
    expect(insertedInboxRows).toHaveLength(mapeamentosAntes);
    expect(mensagens('9611')).toHaveLength(0);
    expect(chamadas('concluir_evento_inbox_chatwoot')).toHaveLength(0);

    inboxFiel.falha = null;
    expect((await entregar(body, { delivery: 'del-9611' })).status).toBe(200);
    expect(mensagens('9611')).toHaveLength(1);
  });

  it('corpo adulterado depois de assinado: 401 sem tocar a inbox', async () => {
    const assinado = corpo({ id: 9612, content: 'original' });
    const res = await entregar(assinado.replace('original', 'adulterado'), { delivery: 'del-9612', corpoAssinado: assinado });
    expect(res.status).toBe(401);
    expect(chamadas('aceitar_entrega_inbox_chatwoot')).toHaveLength(0);
  });

  it('HMAC sobre os bytes originais: acento assinado em bytes é aceito; UTF-8 inválido é 400 depois da assinatura', async () => {
    const bytes = Buffer.from(corpo({ id: 9613, content: 'ação' }), 'utf8');
    expect((await entregar(bytes, { delivery: 'del-9613' })).status).toBe(200);
    const invalido = Buffer.concat([Buffer.from('{"event":"message_created","content":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}')]);
    const res = await entregar(invalido, { delivery: 'del-9614' });
    expect(res.status).toBe(400);
    expect(chamadas('aceitar_entrega_inbox_chatwoot')).toHaveLength(1);
  });

  it('payload acima do limite: 413 antes de qualquer consulta, também sem Content-Length', async () => {
    const grande = corpo({ id: 9615, content: 'x'.repeat(300 * 1024) });
    expect((await entregar(grande, { delivery: 'del-9615' })).status).toBe(413);
    const { POST } = await import('./route');
    const fluxo = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 40; i += 1) controller.enqueue(new Uint8Array(10 * 1024));
        controller.close();
      },
    });
    const semTamanho = new Request(`https://orbita.test/api/chatwoot/webhook/${CONEXAO_A}`, {
      method: 'POST', body: fluxo, duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    expect((await POST(semTamanho, { params: Promise.resolve({ conexaoId: CONEXAO_A }) })).status).toBe(413);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('cabeçalho de entrega ou assinatura fora do formato: recusado antes de consultar a conexão', async () => {
    const body = corpo({ id: 9616 });
    expect((await entregar(body, { delivery: 'id com espaço' })).status).toBe(400);
    const { POST } = await import('./route');
    const req = new Request(`https://orbita.test/api/chatwoot/webhook/${CONEXAO_A}`, {
      method: 'POST', headers: { 'x-chatwoot-signature': 'md5=abc', 'x-chatwoot-timestamp': 'agora' }, body,
    });
    expect((await POST(req, { params: Promise.resolve({ conexaoId: CONEXAO_A }) })).status).toBe(401);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('limite excedido: 429 sem gravar; contador indisponível: 503 (fail-closed)', async () => {
    limitePermite = false;
    expect((await entregar(corpo({ id: 9617 }), { delivery: 'del-9617' })).status).toBe(429);
    limitePermite = null;
    expect((await entregar(corpo({ id: 9617 }), { delivery: 'del-9617' })).status).toBe(503);
    expect(chamadas('aceitar_entrega_inbox_chatwoot')).toHaveLength(0);
  });

  it('account de outra conexão/organização: 403 sem gravar; o segredo de B não autentica a URL de A', async () => {
    expect((await entregar(corpo({ id: 9618, account: { id: 999 } }), { delivery: 'del-9618' })).status).toBe(403);
    expect((await entregar(corpo({ id: 9619 }), { delivery: 'del-9619', segredo: SECRET_B })).status).toBe(401);
    expect(chamadas('aceitar_entrega_inbox_chatwoot')).toHaveLength(0);
  });

  it('logs da entrega não carregam conteúdo da mensagem, nome do contato nem a assinatura', async () => {
    const saidas: string[] = [];
    const capturar = (...args: unknown[]) => { saidas.push(args.map(String).join(' ')); };
    const espioes = [
      vi.spyOn(console, 'info').mockImplementation(capturar),
      vi.spyOn(console, 'warn').mockImplementation(capturar),
      vi.spyOn(console, 'error').mockImplementation(capturar),
    ];
    try {
      inboxFiel.falha = { code: '08006', message: 'falha' };
      await entregar(corpo({ id: 9620, content: 'CONTEUDO-PRIVADO-9620' }), { delivery: 'del-9620' });
      inboxFiel.falha = null;
      await entregar(corpo({ id: 9620, content: 'CONTEUDO-PRIVADO-9620' }), { delivery: 'del-9620' });
    } finally {
      espioes.forEach((s) => s.mockRestore());
    }
    const log = saidas.join('\n');
    expect(log).toContain('chatwoot.webhook.recusada');
    expect(log).toContain('chatwoot.webhook.aceita');
    expect(log).not.toContain('CONTEUDO-PRIVADO-9620');
    expect(log).not.toContain('Cliente 961');
    expect(log).not.toContain('sha256=');
  });
});
