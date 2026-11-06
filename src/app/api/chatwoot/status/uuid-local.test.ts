import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EspelhoChatwootFake } from '../../../../services/__testkit__/espelhoChatwootFake';

/**
 * MSG-003B: o status referencia a conversa só pelo UUID local. A organização
 * vem da sessão; a conexão e o id remoto, da própria conversa, no servidor.
 * Chatwoot e banco dublados: nenhuma chamada real. O envio de mensagem é
 * provado em `send/comando.test.ts` e no consumidor (MSG-008).
 */

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project-ref.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'public-key-12345678901234567890';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'server-key-12345678901234567890';

const ORG_A = '22222222-2222-4222-8222-222222222222';
const ORG_B = '33333333-3333-4333-8333-333333333333';
const CONEXAO_A1 = '11111111-1111-4111-8111-111111111111';
const CONEXAO_B1 = '44444444-4444-4444-8444-444444444444';
const ATOR = '70000000-0000-4000-8000-000000000001';

const estado = vi.hoisted(() => ({
  store: null as unknown as EspelhoChatwootFake,
  organizacao: '',
  status: [] as Array<{ conexaoId: string | undefined; conversa: number; status: string }>,
}));

vi.mock('../../../../services/chatwoot/espelhoChatwootSupabase', () => ({
  criarEspelhoChatwootSupabase: () => new Proxy({}, {
    get: (_alvo, operacao: string) => (...args: unknown[]) =>
      (estado.store as unknown as Record<string, (...a: unknown[]) => unknown>)[operacao]!(...args),
  }),
}));
vi.mock('../../../../lib/supabaseServer', () => ({ supabaseServer: {} }));
vi.mock('../../../../lib/requestOrganizationContext', () => ({
  resolveActiveRequestOrganizationContext: vi.fn(async () =>
    ({ _tag: 'OrganizationContextResolved', context: { organizacao: estado.organizacao } })),
}));
vi.mock('../../../../lib/verifiedOrganizationScope', () => ({
  organizationContextToScope: (context: { organizacao: string }) => ({ organizationId: context.organizacao, actorId: ATOR }),
}));
vi.mock('../../../../services/chatwoot/chatwootAdapter', () => ({
  ChatwootAdapter: {
    forScope: vi.fn(async (_scope: unknown, conexaoId?: string) => ({
      conexaoId,
      toggleConversationStatus: async (conversa: number, status: string) => {
        estado.status.push({ conexaoId, conversa, status });
        return { _tag: 'ChatwootSuccess', data: {} };
      },
    })),
  },
}));

/** Contato 5 → conversa 50 numa conexão; devolve o UUID local da conversa. */
function semearConversa(organizacao: string, conexao: string): string {
  const contato = estado.store.semear('contato', { id: 5, organizacao_id: organizacao, conexao_id: conexao, name: 'Contato' });
  return estado.store.semear('conversa', {
    id: 50, organizacao_id: organizacao, conexao_id: conexao, contact_id: 5, contato_id_local: contato, status: 'open',
  });
}

async function postar(corpo: unknown, organizacao = ORG_A) {
  estado.organizacao = organizacao;
  const { POST } = await import('./route');
  const res = await POST(new Request('https://orbita.test/api/chatwoot/status', { method: 'POST', body: JSON.stringify(corpo) }));
  return { status: res.status, body: await res.json() };
}

beforeEach(async () => {
  const { EspelhoChatwootFake } = await import('../../../../services/__testkit__/espelhoChatwootFake');
  // Modelo depois do MSG-004: duas instalações podem ter a conversa 50.
  estado.store = new EspelhoChatwootFake({ pkGlobal: false });
  estado.status.length = 0;
});

describe('POST /api/chatwoot/status pelo UUID local (MSG-003B)', () => {
  it('altera na conexão da conversa e atualiza só o espelho dela', async () => {
    const conversaA1 = semearConversa(ORG_A, CONEXAO_A1);
    const conversaB = semearConversa(ORG_B, CONEXAO_B1);
    const { status } = await postar({ conversaId: conversaA1, status: 'resolved' });
    expect(status).toBe(200);
    expect(estado.status).toEqual([{ conexaoId: CONEXAO_A1, conversa: 50, status: 'resolved' }]);
    expect(estado.store.porIdLocal('conversa', conversaA1)!.status).toBe('resolved');
    expect(estado.store.porIdLocal('conversa', conversaB)!.status).toBe('open');
  });

  it('UUID de outra organização: 404, sem tocar o Chatwoot nem o espelho', async () => {
    const conversaB = semearConversa(ORG_B, CONEXAO_B1);
    const { status } = await postar({ conversaId: conversaB, status: 'resolved' });
    expect(status).toBe(404);
    expect(estado.status).toEqual([]);
    expect(estado.store.porIdLocal('conversa', conversaB)!.status).toBe('open');
  });

  it('id remoto como referência e status inválido: 400', async () => {
    semearConversa(ORG_A, CONEXAO_A1);
    expect((await postar({ conversationId: 50, status: 'resolved' })).status).toBe(400);
    expect((await postar({ conversaId: 'nao-e-uuid', status: 'resolved' })).status).toBe(400);
    expect(estado.status).toEqual([]);
  });
});
