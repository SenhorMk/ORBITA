import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * PRE-008: `ChatwootAdapter.forScope` é por onde todo envio, consulta de
 * status e sincronização obtém as credenciais. Conexão desligada não monta
 * adapter, então nenhum efeito sai por ela.
 */

const ORG_A = '22222222-2222-4222-8222-222222222222';
const CONEXAO_A = '11111111-1111-4111-8111-111111111111';
const SCOPE = { organizationId: ORG_A, actorId: '70000000-0000-4000-8000-000000000001' } as never;

let conexao: Record<string, unknown> | null = null;
const filtros: Array<[string, unknown]> = [];
const lerCredenciais = vi.fn();

vi.mock('../../lib/supabaseServer', () => ({
  supabaseServer: {
    from: (tabela: string) => {
      if (tabela !== 'conexoes_integracao') throw new Error(`tabela inesperada ${tabela}`);
      const builder = {
        select: () => builder,
        eq: (coluna: string, valor: unknown) => {
          filtros.push([coluna, valor]);
          return builder;
        },
        maybeSingle: () => Promise.resolve({ data: conexao, error: null }),
      };
      return builder;
    },
  },
}));

vi.mock('../../lib/integrations/credentialsVault', () => ({
  credentialsVault: { getDecryptedCredentials: (...args: unknown[]) => lerCredenciais(...args) },
}));

describe('ChatwootAdapter.forScope (PRE-008)', () => {
  beforeEach(() => {
    filtros.length = 0;
    lerCredenciais.mockReset();
    lerCredenciais.mockResolvedValue({ api_token: 'tok-a', account_id: '1', webhook_secret: 'segredo-a' });
  });

  it('monta o adapter da conexão da organização verificada', async () => {
    conexao = { id: CONEXAO_A, metadata: {}, status: 'pendente' };
    const { ChatwootAdapter } = await import('./chatwootAdapter');

    const adapter = await ChatwootAdapter.forScope(SCOPE);

    expect(adapter?.conexaoId).toBe(CONEXAO_A);
    expect(filtros).toContainEqual(['organizacao_id', ORG_A]);
    expect(lerCredenciais).toHaveBeenCalledWith(ORG_A, CONEXAO_A);
  });

  it('conexão desligada não monta adapter e nem lê o cofre', async () => {
    conexao = { id: CONEXAO_A, metadata: {}, status: 'desconectado' };
    const { ChatwootAdapter } = await import('./chatwootAdapter');

    expect(await ChatwootAdapter.forScope(SCOPE)).toBeNull();
    expect(await ChatwootAdapter.forScope(SCOPE, CONEXAO_A)).toBeNull();
    expect(lerCredenciais).not.toHaveBeenCalled();
  });
});
