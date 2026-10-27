import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import { autorizarReplay, listarEventosComAtencao, resolverDesconhecido } from './decisoesDaOutbox';

const scope = { organizationId: 'org-1', actorId: 'user-1', role: 'owner' } as unknown as VerifiedOrganizationScope;

const mockRpc = vi.fn();
const mockFrom = vi.fn();

const mockSupabase = {
  rpc: (...args: unknown[]) => mockRpc(...args),
  from: (...args: unknown[]) => mockFrom(...args),
} as unknown as SupabaseClient;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('decisoesDaOutbox', () => {
  describe('decisões humanas', () => {
    it('maps the database refusals to typed failures', async () => {
      const casos: Array<[string, string]> = [['42501', 'SemPapel'], ['P0002', 'NaoEncontrado'], ['55000', 'EstadoNaoAdmite'], ['22023', 'EntradaInvalida']];
      for (const [code, falha] of casos) {
        mockRpc.mockResolvedValueOnce({ data: null, error: { code, message: 'x' } });
        expect(await autorizarReplay(mockSupabase, scope, 'evt-1')).toEqual({ _tag: 'DecisaoRecusada', falha });
      }
    });

    it('passes organization and actor from the verified scope', async () => {
      mockRpc.mockResolvedValueOnce({ data: 'unknown', error: null });

      const result = await resolverDesconhecido(mockSupabase, scope, 'evt-1', { resolucao: 'provado_nao_aplicado', evidencia: 'conferido' });

      expect(result).toEqual({ _tag: 'DecisaoAplicada', status: 'unknown' });
      expect(mockRpc).toHaveBeenCalledWith('resolver_evento_desconhecido_outbox', {
        p_organizacao_id: 'org-1', p_evento_id: 'evt-1', p_ator_id: 'user-1',
        p_resolucao: 'provado_nao_aplicado', p_recibo_ref: null, p_evidencia: 'conferido',
      });
    });

    it('throws an unexpected database error', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: { code: '08006', message: 'conexão perdida' } });

      await expect(autorizarReplay(mockSupabase, scope, 'evt-1')).rejects.toThrow('conexão perdida');
    });
  });

  describe('listarEventosComAtencao', () => {
    it('filters by the verified organization, explains each block and never selects the payload', async () => {
      const eventoId = '11111111-1111-4111-8111-111111111111';
      const consultas: Array<{ tabela: string; colunas: string; filtros: Array<[string, unknown]> }> = [];
      const respostas: Record<string, unknown[]> = {
        outbox_eventos: [{
          id: eventoId, destination: 'chatwoot', event_type: 'message.send', status: 'unknown',
          motivo_bloqueio: 'timeout', resolucao: null, attempts: 1, updated_at: '2026-10-26T00:00:00Z',
        }],
        outbox_tentativas: [{
          evento_id: eventoId, fencing_token: 1, desfecho: 'desconhecido', motivo: 'timeout',
          iniciada_em: '2026-10-26T00:00:00Z', concluida_em: '2026-10-26T00:00:01Z',
        }],
      };
      mockFrom.mockImplementation((tabela: string) => {
        const consulta = { tabela, colunas: '', filtros: [] as Array<[string, unknown]> };
        consultas.push(consulta);
        const cadeia = {
          select: (colunas: string) => { consulta.colunas = colunas; return cadeia; },
          eq: (coluna: string, valor: unknown) => { consulta.filtros.push([coluna, valor]); return cadeia; },
          in: (coluna: string, valor: unknown) => { consulta.filtros.push([coluna, valor]); return cadeia; },
          order: () => cadeia,
          limit: () => cadeia,
          then: (resolve: (v: unknown) => void) => resolve({ data: respostas[tabela], error: null }),
        };
        return cadeia;
      });

      const [evento] = await listarEventosComAtencao(mockSupabase, scope);

      expect(consultas.map((c) => c.tabela)).toEqual(['outbox_eventos', 'outbox_tentativas']);
      for (const c of consultas) {
        expect(c.filtros).toContainEqual(['organizacao_id', 'org-1']);
        expect(c.colunas).not.toMatch(/payload/u);
      }
      expect(evento).toMatchObject({ desfecho: 'desconhecido', podeRepetir: false, tentativas: [{ fencingToken: 1, desfecho: 'desconhecido' }] });
      expect(evento!.explicacao).toMatch(/Não reenvie/u);
    });
  });

});
