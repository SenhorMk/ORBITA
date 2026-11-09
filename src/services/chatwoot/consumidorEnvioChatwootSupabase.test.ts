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
  privada: false,
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

describe('claim e início do despacho pelo protocolo do MSG-009', () => {
  function comRpc(responder: (fn: string, args: Record<string, unknown>) => { data: unknown; error: unknown }) {
    const chamadas: Array<{ fn: string; args: Record<string, unknown> }> = [];
    const supabase = {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        chamadas.push({ fn, args });
        return responder(fn, args);
      },
    } as unknown as SupabaseClient;
    return { porta: criarPortaDoConsumidorEnvio(supabase), chamadas };
  }

  it('o claim manda o protocolo 2 e lê se o envio é nota privada', async () => {
    const { porta, chamadas } = comRpc(() => ({
      data: [{
        evento_id: envio.eventoId, organizacao_id: ORG, conexao_id: CONEXAO, envio_id: envio.envioId, ator_id: ATOR,
        conversa_id_externo: '10', conteudo: 'NOTA', privada: true, correlation_id: null, fencing_token: '3',
      }],
      error: null,
    }));
    const [lido] = await porta.reivindicar({ workerId: 'w', limite: 5, leaseSegundos: 60, criadosDesde: '2026-11-09T00:00:00Z' });

    expect(chamadas[0]).toMatchObject({ fn: 'reivindicar_envios_chatwoot', args: { p_protocolo: 2 } });
    expect(lido).toMatchObject({ privada: true, fencingToken: 3, conversaIdExterno: 10 });
  });

  it('linha do claim sem o campo privada é recusada: nunca se adivinha que é mensagem', async () => {
    const { porta } = comRpc(() => ({
      data: [{
        evento_id: envio.eventoId, organizacao_id: ORG, conexao_id: CONEXAO, envio_id: envio.envioId, ator_id: ATOR,
        conversa_id_externo: '10', conteudo: 'X', correlation_id: null, fencing_token: '3',
      }],
      error: null,
    }));
    await expect(porta.reivindicar({ workerId: 'w', limite: 5, leaseSegundos: 60, criadosDesde: '2026-11-09T00:00:00Z' })).rejects.toThrow();
  });

  it.each(['iniciado', 'invalidado', 'posse_perdida'] as const)('o início usa iniciar_envio_chatwoot e devolve %s', async (resultado) => {
    const { porta, chamadas } = comRpc(() => ({ data: resultado, error: null }));
    await expect(porta.iniciarDespacho({ eventoId: envio.eventoId, workerId: 'w', fencingToken: 3 })).resolves.toBe(resultado);
    expect(chamadas[0]!.fn).toBe('iniciar_envio_chatwoot');
  });

  it('início com resposta fora do contrato falha, sem afirmar que começou', async () => {
    const { porta } = comRpc(() => ({ data: true, error: null }));
    await expect(porta.iniciarDespacho({ eventoId: envio.eventoId, workerId: 'w', fencingToken: 3 })).rejects.toThrow();
  });
});
