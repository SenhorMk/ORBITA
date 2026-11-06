import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { criarPortaDoConsumidorEnvio } from './consumidorEnvioChatwootSupabase';
import type { EnvioReivindicado } from './consumidorEnvioChatwoot';

const forScope = vi.hoisted(() => vi.fn());
vi.mock('./chatwootAdapter', () => ({ ChatwootAdapter: { forScope } }));

const ORG = 'e0080000-0000-4000-8000-00000000000a';
const CONEXAO = 'e0080000-0000-4000-8000-0000000000c1';
const ATOR = 'e0080000-0000-4000-8000-0000000000a1';

const envio: EnvioReivindicado = {
  eventoId: 'e0080000-0000-4000-8000-0000000000e1',
  organizacaoId: ORG,
  conexaoId: CONEXAO,
  envioId: 'e0080000-0000-4000-8000-0000000000f1',
  atorId: ATOR,
  conversaIdExterno: 10,
  conteudo: 'RESPOSTA',
  correlationId: null,
  fencingToken: 1,
};

/** Cada tabela responde uma linha (ou um erro) a qualquer cadeia de filtros. */
function banco(respostas: Record<string, { data: unknown; error: unknown }>): SupabaseClient {
  const consulta = (tabela: string) => {
    const cadeia = {
      select: () => cadeia,
      eq: () => cadeia,
      maybeSingle: async () => respostas[tabela] ?? { data: null, error: null },
    };
    return cadeia;
  };
  return { from: consulta } as unknown as SupabaseClient;
}

const membro = { data: { papel: 'member' }, error: null };

describe('resolverCanal do worker de envio', () => {
  it('banco fora ao ler a conexão é falha passageira, nunca recusa definitiva', async () => {
    const porta = criarPortaDoConsumidorEnvio(banco({
      membros_organizacao: membro,
      conexoes_integracao: { data: null, error: { message: 'connection reset' } },
    }));
    await expect(porta.resolverCanal(envio)).rejects.toThrow();
    expect(forScope).not.toHaveBeenCalled();
  });

  it('conexão desligada é recusa definitiva, sem montar o adapter', async () => {
    const porta = criarPortaDoConsumidorEnvio(banco({
      membros_organizacao: membro,
      conexoes_integracao: { data: { status: 'desconectado' }, error: null },
    }));
    await expect(porta.resolverCanal(envio)).resolves.toEqual({ _tag: 'NaoConfigurado' });
    expect(forScope).not.toHaveBeenCalled();
  });

  it('conexão ligada segue para o adapter da própria conexão', async () => {
    const canal = { conexaoId: CONEXAO, sendMessage: vi.fn() };
    forScope.mockResolvedValueOnce(canal);
    const porta = criarPortaDoConsumidorEnvio(banco({
      membros_organizacao: membro,
      conexoes_integracao: { data: { status: 'conectado' }, error: null },
    }));
    await expect(porta.resolverCanal(envio)).resolves.toEqual({ _tag: 'Canal', canal });
  });
});
