import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project-ref.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'public-key-12345678901234567890';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'server-key-12345678901234567890';

const ORG = '22222222-2222-4222-8222-222222222222';
const ATOR = '70000000-0000-4000-8000-000000000001';
const CONEXAO = '11111111-1111-4111-8111-111111111111';

const upserts: Array<{ table: string; row: Record<string, unknown> }> = [];

vi.mock('../../../../lib/supabaseServer', () => ({
  supabaseServer: {
    from: (table: string) => ({
      upsert: (row: Record<string, unknown>) => {
        upserts.push({ table, row });
        return Promise.resolve({ error: null });
      },
    }),
  },
}));
vi.mock('../../../../lib/requestOrganizationContext', () => ({
  resolveActiveRequestOrganizationContext: vi.fn().mockResolvedValue({ _tag: 'OrganizationContextResolved', context: {} }),
}));
vi.mock('../../../../lib/verifiedOrganizationScope', () => ({
  organizationContextToScope: () => ({ organizationId: ORG, actorId: ATOR }),
}));
vi.mock('../../../../services/chatwoot/chatwootInboxRegistration', () => ({
  registerChatwootInboxIfNeeded: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../../services/integrationService', () => ({
  registroDoSacSupabase: {},
  vincularSacAoErp: vi.fn().mockResolvedValue({ criados: 0, falhas: 0 }),
}));
vi.mock('../../../../services/chatwoot/chatwootAdapter', () => ({
  ChatwootAdapter: {
    forScope: vi.fn().mockResolvedValue({
      conexaoId: CONEXAO,
      getConversations: () => Promise.resolve({
        _tag: 'ChatwootSuccess',
        data: [{ id: 50, display_id: 50, inbox_id: 1, status: 'open', meta: { sender: { id: 5, name: 'Contato' } } }],
      }),
      getMessages: () => Promise.resolve({
        _tag: 'ChatwootSuccess',
        data: [{ id: 500, content: 'oi', message_type: 0, created_at: '2026-10-25T00:00:00Z' }],
      }),
    }),
  },
}));

describe('POST /api/chatwoot/sync (MSG-002: escrita compatível)', () => {
  beforeEach(() => {
    upserts.length = 0;
  });

  it('grava contato, conversa e mensagem na organização verificada e na conexão do adapter', async () => {
    const { POST } = await import('./route');
    const response = await POST(new Request('https://orbita.test/api/chatwoot/sync', { method: 'POST' }));

    expect(response.status).toBe(200);
    expect(upserts.map((u) => u.table)).toEqual(['chatwoot_contacts', 'chatwoot_conversations', 'chatwoot_messages']);
    for (const { row } of upserts) {
      expect(row).toMatchObject({ organizacao_id: ORG, conexao_id: CONEXAO, user_id: ATOR });
    }
  });
});
