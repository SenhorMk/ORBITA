import { describe, expect, it, vi } from 'vitest';

/**
 * PRE-008: desligar a conexão com uma operação pendente. O envio pedido
 * depois da pausa fica registrado na outbox como falha, sem chamar o Chatwoot
 * e sem gravar mensagem local; a conexão, o mapping e o histórico ficam.
 * O `ChatwootAdapter.forScope` é o real: só o banco e a rede são dublados.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project-ref.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'public-key-12345678901234567890';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'server-key-12345678901234567890';

const ORG_A = '22222222-2222-4222-8222-222222222222';
const CONEXAO_A = '11111111-1111-4111-8111-111111111111';
const CONVERSA_A = 'c0000000-0000-4000-8000-000000000201';

const enqueue = vi.fn().mockResolvedValue({ eventoId: 'evt-1' });
const claimOne = vi.fn().mockResolvedValue(1);
const startDispatch = vi.fn();
const concludeAttempt = vi.fn().mockResolvedValue('dead_letter');
const lerCredenciais = vi.fn();
const escritasEmMensagens: unknown[] = [];

vi.mock('../../../../lib/requestOrganizationContext', () => ({
  resolveActiveRequestOrganizationContext: vi.fn().mockResolvedValue({
    _tag: 'OrganizationContextResolved',
    context: { actorId: 'actor-1', organizationId: ORG_A, role: 'member', capabilities: new Set(['organization:access']) },
  }),
}));

vi.mock('../../../../services/outboxService', () => ({
  outboxService: {
    enqueue: (...a: unknown[]) => enqueue(...a),
    claimOne: (...a: unknown[]) => claimOne(...a),
    startDispatch: (...a: unknown[]) => startDispatch(...a),
    concludeAttempt: (...a: unknown[]) => concludeAttempt(...a),
  },
}));

vi.mock('../../../../lib/integrations/credentialsVault', () => ({
  credentialsVault: { getDecryptedCredentials: (...a: unknown[]) => lerCredenciais(...a) },
}));

vi.mock('../../../../lib/supabaseServer', () => ({
  supabaseServer: {
    from: (tabela: string) => {
      let colunas = '';
      const builder = {
        select: (lidas: string) => {
          colunas = lidas;
          return builder;
        },
        eq: () => builder,
        upsert: (linha: unknown) => {
          escritasEmMensagens.push(linha);
          return Promise.resolve({ error: null });
        },
        update: () => builder,
        maybeSingle: () => {
          // A conversa (MSG-003B): a conexão dela e, nessa conexão, o id remoto.
          if (tabela === 'chatwoot_conversations') {
            return Promise.resolve({ data: colunas === 'conexao_id' ? { conexao_id: CONEXAO_A } : { id_externo: '201' }, error: null });
          }
          return Promise.resolve({ data: { id: CONEXAO_A, metadata: {}, status: 'desconectado' }, error: null });
        },
      };
      return builder;
    },
  },
}));

describe('POST /api/chatwoot/send com a conexão desligada (PRE-008)', () => {
  it('registra a tentativa como falha, não chama o Chatwoot nem grava mensagem', async () => {
    const rede = vi.spyOn(globalThis, 'fetch');
    const erro = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { POST } = await import('./route');
      const res = await POST(new Request('https://orbita.test/api/chatwoot/send', {
        method: 'POST',
        body: JSON.stringify({ conversaId: CONVERSA_A, content: 'resposta depois da pausa' }),
      }));

      expect(res.status).toBe(409);
      expect(enqueue).toHaveBeenCalledTimes(1);
      expect(claimOne).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ organizationId: ORG_A }),
        'evt-1', 'chatwoot-http-inline-send');
      // Recusa a partir do claim: nada foi despachado.
      expect(startDispatch).not.toHaveBeenCalled();
      expect(concludeAttempt).toHaveBeenCalledWith(expect.anything(),
        { eventoId: 'evt-1', workerId: 'chatwoot-http-inline-send', fencingToken: 1 },
        expect.objectContaining({ _tag: 'Recusado', codigo: 'nao_configurado' }));
      expect(lerCredenciais).not.toHaveBeenCalled();
      expect(rede).not.toHaveBeenCalled();
      expect(escritasEmMensagens).toEqual([]);
    } finally {
      rede.mockRestore();
      erro.mockRestore();
    }
  });
});
