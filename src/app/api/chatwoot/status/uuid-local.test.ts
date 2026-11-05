import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EspelhoChatwootFake } from '../../../../services/__testkit__/espelhoChatwootFake';

/**
 * MSG-003B: envio e status referenciam a conversa só pelo UUID local. A
 * organização vem da sessão; a conexão e o id remoto, da própria conversa, no
 * servidor. Chatwoot e banco dublados: nenhuma chamada real.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project-ref.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'public-key-12345678901234567890';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'server-key-12345678901234567890';

const ORG_A = '22222222-2222-4222-8222-222222222222';
const ORG_B = '33333333-3333-4333-8333-333333333333';
const CONEXAO_A1 = '11111111-1111-4111-8111-111111111111';
const CONEXAO_A2 = '11111111-1111-4111-8111-111111111112';
const CONEXAO_B1 = '44444444-4444-4444-8444-444444444444';
const ATOR = '70000000-0000-4000-8000-000000000001';

const estado = vi.hoisted(() => ({
  store: null as unknown as EspelhoChatwootFake,
  sessao: { _tag: 'OrganizationContextResolved', organizacao: '' } as { _tag: string; organizacao: string },
  adapters: [] as Array<{ conexaoId: string | undefined }>,
  enviadas: [] as Array<{ conexaoId: string | undefined; conversa: number; conteudo: string }>,
  status: [] as Array<{ conexaoId: string | undefined; conversa: number; status: string }>,
  enqueue: vi.fn(),
  claimOne: vi.fn(),
  startDispatch: vi.fn(),
  concludeAttempt: vi.fn(),
  auditoria: vi.fn(),
  /** A próxima resposta do Chatwoot; `null` = sucesso com id. */
  resposta: null as unknown,
}));

vi.mock('../../../../services/chatwoot/espelhoChatwootSupabase', () => ({
  criarEspelhoChatwootSupabase: () => new Proxy({}, {
    get: (_alvo, operacao: string) => (...args: unknown[]) =>
      (estado.store as unknown as Record<string, (...a: unknown[]) => unknown>)[operacao]!(...args),
  }),
}));
vi.mock('../../../../lib/supabaseServer', () => ({ supabaseServer: {} }));
vi.mock('../../../../lib/requestOrganizationContext', () => ({
  resolveActiveRequestOrganizationContext: vi.fn(async () => (estado.sessao._tag === 'OrganizationContextResolved'
    ? { _tag: 'OrganizationContextResolved', context: { organizacao: estado.sessao.organizacao } }
    : { _tag: estado.sessao._tag })),
}));
vi.mock('../../../../lib/verifiedOrganizationScope', () => ({
  organizationContextToScope: (context: { organizacao: string }) => ({ organizationId: context.organizacao, actorId: ATOR }),
}));
vi.mock('../../../../services/outboxService', () => ({
  outboxService: {
    enqueue: (...a: unknown[]) => estado.enqueue(...a),
    claimOne: (...a: unknown[]) => estado.claimOne(...a),
    startDispatch: (...a: unknown[]) => estado.startDispatch(...a),
    concludeAttempt: (...a: unknown[]) => estado.concludeAttempt(...a),
  },
}));
vi.mock('../../../../services/auditService', () => ({
  recordSystemAuditEvent: (...a: unknown[]) => estado.auditoria(...a),
}));
vi.mock('../../../../services/chatwoot/chatwootAdapter', () => ({
  ChatwootAdapter: {
    forScope: vi.fn(async (_scope: unknown, conexaoId?: string) => {
      estado.adapters.push({ conexaoId });
      return {
        conexaoId,
        sendMessage: async (conversa: number, conteudo: string) => {
          estado.enviadas.push({ conexaoId, conversa, conteudo });
          if (estado.resposta === 'lancar') throw new Error('socket hang up');
          if (estado.resposta) return estado.resposta;
          return { _tag: 'ChatwootSuccess', data: { id: 9000 + estado.enviadas.length, message_type: 1, created_at: '2026-10-26T12:00:00Z' } };
        },
        toggleConversationStatus: async (conversa: number, status: string) => {
          estado.status.push({ conexaoId, conversa, status });
          return { _tag: 'ChatwootSuccess', data: {} };
        },
      };
    }),
  },
}));

/** Contato 5 → conversa 50 numa conexão; devolve o UUID local da conversa. */
function semearConversa(organizacao: string, conexao: string | null): string {
  const contato = estado.store.semear('contato', { id: 5, organizacao_id: organizacao, conexao_id: conexao, name: 'Contato' });
  return estado.store.semear('conversa', {
    id: 50, organizacao_id: organizacao, conexao_id: conexao, contact_id: 5, contato_id_local: contato, status: 'open',
  });
}

async function postar(rota: 'send' | 'status', corpo: unknown, organizacao = ORG_A) {
  estado.sessao = { _tag: 'OrganizationContextResolved', organizacao };
  const { POST } = rota === 'send' ? await import('./route') : await import('../status/route');
  const res = await POST(new Request(`https://orbita.test/api/chatwoot/${rota}`, { method: 'POST', body: JSON.stringify(corpo) }));
  return { status: res.status, body: await res.json() };
}

beforeEach(async () => {
  const { EspelhoChatwootFake } = await import('../../../../services/__testkit__/espelhoChatwootFake');
  // Modelo depois do MSG-004: duas instalações podem ter a conversa 50.
  estado.store = new EspelhoChatwootFake({ pkGlobal: false });
  estado.adapters.length = 0;
  estado.enviadas.length = 0;
  estado.status.length = 0;
  estado.enqueue.mockReset().mockResolvedValue({ eventoId: 'evt-1' });
  estado.claimOne.mockReset().mockResolvedValue(1);
  estado.startDispatch.mockReset().mockResolvedValue(true);
  estado.concludeAttempt.mockReset().mockImplementation(async (_s: unknown, _p: unknown, desfecho: { _tag: string }) =>
    ({ Confirmado: 'sent', NaoEnviado: 'failed_transient', Recusado: 'dead_letter', Desconhecido: 'unknown' })[desfecho._tag]);
  estado.auditoria.mockReset().mockResolvedValue('audit-1');
  estado.resposta = null;
});

describe('POST /api/chatwoot/send pelo UUID local (MSG-003B)', () => {
  it('envia pela conexão da conversa, com o id remoto resolvido no servidor, e devolve só UUID', async () => {
    const conversaA1 = semearConversa(ORG_A, CONEXAO_A1);
    semearConversa(ORG_B, CONEXAO_B1);
    const { status, body } = await postar('send', { conversaId: conversaA1, content: 'olá' });

    expect(status).toBe(200);
    expect(estado.adapters).toEqual([{ conexaoId: CONEXAO_A1 }]);
    expect(estado.enviadas).toEqual([{ conexaoId: CONEXAO_A1, conversa: 50, conteudo: 'olá' }]);
    const gravada = estado.store.linhas.mensagem[0]!;
    expect(gravada).toMatchObject({ organizacao_id: ORG_A, conexao_id: CONEXAO_A1, conversa_id_local: conversaA1, content: 'olá' });
    expect(body.message).toMatchObject({ id_local: gravada.id_local, conversa_id_local: conversaA1, content: 'olá' });
    expect(body.message).not.toHaveProperty('id');
    // A outbox registra a referência local, não o id remoto.
    expect(estado.enqueue.mock.calls[0]![2]).toMatchObject({ payload: { conversaIdLocal: conversaA1, conexaoId: CONEXAO_A1, content: 'olá' } });
  });

  it('duas instalações da mesma organização com a conversa 50: cada UUID vai para a sua conexão', async () => {
    semearConversa(ORG_A, CONEXAO_A1);
    const conversaA2 = semearConversa(ORG_A, CONEXAO_A2);
    await postar('send', { conversaId: conversaA2, content: 'pela segunda' });
    expect(estado.enviadas).toEqual([{ conexaoId: CONEXAO_A2, conversa: 50, conteudo: 'pela segunda' }]);
    expect(estado.store.linhas.mensagem[0]).toMatchObject({ conexao_id: CONEXAO_A2, conversa_id_local: conversaA2 });
  });

  it('id remoto como referência é recusado (sem fallback): 400, sem outbox nem Chatwoot', async () => {
    semearConversa(ORG_A, CONEXAO_A1);
    const { status } = await postar('send', { conversationId: 50, content: 'pelo id remoto' });
    expect(status).toBe(400);
    expect(estado.enqueue).not.toHaveBeenCalled();
    expect(estado.adapters).toEqual([]);
  });

  it('UUID de outra organização ou adulterado: 404, sem outbox nem Chatwoot', async () => {
    const conversaB = semearConversa(ORG_B, CONEXAO_B1);
    for (const conversaId of [conversaB, 'c0000000-0000-4000-8000-0000000000ff']) {
      const { status, body } = await postar('send', { conversaId, content: 'intrusa' });
      expect(status).toBe(404);
      expect(body).toMatchObject({ error: 'Conversa não encontrada', motivo: 'IdentidadeNaoEncontrada' });
    }
    expect(estado.enqueue).not.toHaveBeenCalled();
    expect(estado.enviadas).toEqual([]);
    expect(estado.store.linhas.mensagem).toEqual([]);
  });

  it('conversa legada sem conexão provada: 422 tipado, sem envio', async () => {
    const legada = semearConversa(ORG_A, null);
    const { status, body } = await postar('send', { conversaId: legada, content: 'x' });
    expect(status).toBe(422);
    expect(body.motivo).toBe('ConexaoNaoComprovada');
    expect(estado.enviadas).toEqual([]);
  });

  it('sem vínculo com a organização: 403 e nada acontece', async () => {
    const conversaA1 = semearConversa(ORG_A, CONEXAO_A1);
    estado.sessao = { _tag: 'OrganizationMembershipMissing', organizacao: ORG_A };
    const { POST } = await import('./route');
    const res = await POST(new Request('https://orbita.test/api/chatwoot/send', {
      method: 'POST', body: JSON.stringify({ conversaId: conversaA1, content: 'x' }),
    }));
    expect(res.status).toBe(403);
    expect(estado.store.chamadas).toEqual([]);
    expect(estado.enqueue).not.toHaveBeenCalled();
  });
});

describe('POST /api/chatwoot/send com efeito ambíguo (MSG-007)', () => {
  const falhou = (reason: string, status?: number) => ({ _tag: 'ChatwootFailed', reason, status, retryable: true });

  it('confirma só com recibo: in_flight antes da rede, sent pelo mesmo token', async () => {
    const conversaA1 = semearConversa(ORG_A, CONEXAO_A1);
    const { status } = await postar('send', { conversaId: conversaA1, content: 'olá' });
    expect(status).toBe(200);
    expect(estado.startDispatch).toHaveBeenCalledWith({}, 'evt-1', 'chatwoot-http-inline-send', 1);
    expect(estado.concludeAttempt).toHaveBeenCalledWith({}, { eventoId: 'evt-1', workerId: 'chatwoot-http-inline-send', fencingToken: 1 },
      { _tag: 'Confirmado', recibo: '9001', resposta: { id: 9001 } });
  });

  it.each([
    ['timeout', falhou('timeout'), 'timeout'],
    ['ACK perdido', falhou('network'), 'ack_perdido'],
    ['2xx inválido', falhou('invalid-response'), 'resposta_invalida'],
    ['5xx', falhou('http', 503), 'erro_do_provedor'],
    ['429 sem prova', falhou('rate-limited', 429), 'limite_sem_prova'],
  ])('%s: 202 desconhecido, sem mensagem local, auditado e sem pedir reenvio', async (_nome, resposta, motivo) => {
    const conversaA1 = semearConversa(ORG_A, CONEXAO_A1);
    estado.resposta = resposta;
    const { status, body } = await postar('send', { conversaId: conversaA1, content: 'olá' });
    expect(status).toBe(202);
    expect(body).toMatchObject({ success: false, desfecho: 'desconhecido', eventoId: 'evt-1' });
    expect(body.error).toMatch(/não reenvie/u);
    expect(estado.concludeAttempt.mock.calls[0]![2]).toMatchObject({ _tag: 'Desconhecido', motivo });
    expect(estado.store.linhas.mensagem).toEqual([]);
    expect(estado.enviadas).toHaveLength(1);
    expect(estado.auditoria).toHaveBeenCalledWith({}, expect.objectContaining({
      acao: 'outbox.effect_unknown', organizationId: ORG_A, recursoId: 'evt-1',
      metadata: expect.not.objectContaining({ content: expect.anything() }),
    }));
  });

  it('recusa definitiva: dead_letter e o status do Chatwoot', async () => {
    const conversaA1 = semearConversa(ORG_A, CONEXAO_A1);
    estado.resposta = falhou('http', 422);
    const { status, body } = await postar('send', { conversaId: conversaA1, content: 'olá' });
    expect(status).toBe(422);
    expect(body.desfecho).toBe('recusado');
    expect(estado.auditoria).not.toHaveBeenCalled();
  });

  it('recibo recebido mas a lease já venceu (CAS recusou): 202, nada afirmado', async () => {
    const conversaA1 = semearConversa(ORG_A, CONEXAO_A1);
    estado.concludeAttempt.mockResolvedValueOnce(null);
    const { status, body } = await postar('send', { conversaId: conversaA1, content: 'olá' });
    expect(status).toBe(202);
    expect(body.desfecho).toBe('desconhecido');
    expect(estado.store.linhas.mensagem).toEqual([]);
  });

  it('falha depois do despacho (adapter lança ou gravar o desfecho falha): 202, nunca 500 de "tente de novo"', async () => {
    const conversaA1 = semearConversa(ORG_A, CONEXAO_A1);
    estado.resposta = 'lancar';
    const lancou = await postar('send', { conversaId: conversaA1, content: 'a' });
    expect(lancou.status).toBe(202);
    expect(estado.concludeAttempt.mock.calls[0]![2]).toMatchObject({ _tag: 'Desconhecido', motivo: 'falha_apos_despacho' });

    estado.resposta = null;
    estado.concludeAttempt.mockRejectedValueOnce(new Error('banco fora'));
    const semGravar = await postar('send', { conversaId: conversaA1, content: 'b' });
    expect(semGravar.status).toBe(202);
    expect(semGravar.body.desfecho).toBe('desconhecido');
    expect(estado.store.linhas.mensagem).toEqual([]);
  });

  it('evento que não está na fila, ou posse perdida antes da rede: 409 e nenhum envio', async () => {
    const conversaA1 = semearConversa(ORG_A, CONEXAO_A1);
    estado.claimOne.mockResolvedValueOnce(null);
    expect((await postar('send', { conversaId: conversaA1, content: 'a' })).status).toBe(409);
    estado.startDispatch.mockResolvedValueOnce(false);
    expect((await postar('send', { conversaId: conversaA1, content: 'b' })).status).toBe(409);
    expect(estado.enviadas).toEqual([]);
    expect(estado.concludeAttempt).not.toHaveBeenCalled();
  });
});

describe('POST /api/chatwoot/status pelo UUID local (MSG-003B)', () => {
  it('altera na conexão da conversa e atualiza só o espelho dela', async () => {
    const conversaA1 = semearConversa(ORG_A, CONEXAO_A1);
    const conversaB = semearConversa(ORG_B, CONEXAO_B1);
    const { status } = await postar('status', { conversaId: conversaA1, status: 'resolved' });
    expect(status).toBe(200);
    expect(estado.status).toEqual([{ conexaoId: CONEXAO_A1, conversa: 50, status: 'resolved' }]);
    expect(estado.store.porIdLocal('conversa', conversaA1)!.status).toBe('resolved');
    expect(estado.store.porIdLocal('conversa', conversaB)!.status).toBe('open');
  });

  it('UUID de outra organização: 404, sem tocar o Chatwoot nem o espelho', async () => {
    const conversaB = semearConversa(ORG_B, CONEXAO_B1);
    const { status } = await postar('status', { conversaId: conversaB, status: 'resolved' });
    expect(status).toBe(404);
    expect(estado.status).toEqual([]);
    expect(estado.store.porIdLocal('conversa', conversaB)!.status).toBe('open');
  });

  it('id remoto como referência e status inválido: 400', async () => {
    semearConversa(ORG_A, CONEXAO_A1);
    expect((await postar('status', { conversationId: 50, status: 'resolved' })).status).toBe(400);
    expect((await postar('status', { conversaId: 'nao-e-uuid', status: 'resolved' })).status).toBe(400);
    expect(estado.status).toEqual([]);
  });
});
