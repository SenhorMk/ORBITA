import { beforeAll, describe, expect, it, vi } from 'vitest';
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

const mockRpc = vi.fn().mockImplementation((fnName: string) => {
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
