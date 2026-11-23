import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import type { VerifiedOrganizationScope } from '../../lib/verifiedOrganizationScope';
import { lerUltimoEnvioPublicoDaConversa, listarEnviosDaConversa, RegistroDeEnvioIndisponivel } from './envioChatwoot';

const scope = { organizationId: 'e0080000-0000-4000-8000-00000000000a', actorId: 'e0080000-0000-4000-8000-0000000000a1' } as VerifiedOrganizationScope;

function respondendo(data: unknown): SupabaseClient {
  const cadeia = {
    select: () => cadeia,
    eq: () => cadeia,
    order: () => cadeia,
    limit: async () => ({ data, error: null }),
  };
  return { from: () => cadeia } as unknown as SupabaseClient;
}

describe('listarEnviosDaConversa', () => {
  it('linha fora do formato esperado é indisponibilidade tipada, não exceção solta', async () => {
    await expect(listarEnviosDaConversa(respondendo([{ id: 1 }]), scope, 'e0080000-0000-4000-8000-0000000000d1'))
      .rejects.toBeInstanceOf(RegistroDeEnvioIndisponivel);
  });
  it('exibe a invalidação de autorresposta registrada na outbox', async () => {
    const supabase = respondendo([{
      id: 'envio', command_id: 'comando', conteudo: 'sintético', mensagem_id_local: null,
      invalidado_em: null, created_at: '2026-11-16T00:00:00Z',
      outbox_eventos: {
        status: 'dead_letter', motivo_bloqueio: null, resolucao: null, last_error: 'autorresposta_invalidada',
      },
    }]);
    const [envio] = await listarEnviosDaConversa(supabase, scope, 'e0080000-0000-4000-8000-0000000000d1');
    expect(envio).toMatchObject({
      estado: 'invalidado',
      explicacao: 'Resposta automática invalidada pela política antes do envio.',
    });
  });});

describe('lerUltimoEnvioPublicoDaConversa (corte do que já foi respondido)', () => {
  const ESCOPO = { organizacaoId: 'e0080000-0000-4000-8000-00000000000a', conexaoId: 'e0080000-0000-4000-8000-0000000000c1' };
  const CONVERSA = 'e0080000-0000-4000-8000-0000000000d1';
  function gravador(resposta: { data: unknown; error: unknown }) {
    const chamadas: unknown[][] = [];
    const cadeia: Record<string, unknown> = {};
    for (const metodo of ['select', 'eq', 'is', 'order', 'limit']) {
      cadeia[metodo] = (...args: unknown[]) => { chamadas.push([metodo, ...args]); return cadeia; };
    }
    cadeia.then = (resolver: (v: unknown) => void) => resolver(resposta);
    const cliente = { from: (tabela: string) => { chamadas.push(['from', tabela]); return cadeia; } } as unknown as SupabaseClient;
    return { cliente, chamadas };
  }

  it('só envio público, não invalidado, da organização, conexão e conversa; lê só o instante', async () => {
    const { cliente, chamadas } = gravador({ data: [{ created_at: '2026-11-23T15:00:12.797+00:00' }], error: null });
    await expect(lerUltimoEnvioPublicoDaConversa(cliente, ESCOPO, CONVERSA)).resolves.toBe('2026-11-23T15:00:12.797+00:00');
    expect(chamadas).toEqual([
      ['from', 'chatwoot_envios'], ['select', 'created_at'],
      ['eq', 'organizacao_id', ESCOPO.organizacaoId], ['eq', 'conexao_id', ESCOPO.conexaoId], ['eq', 'conversa_id_local', CONVERSA],
      ['eq', 'privada', false], ['is', 'invalidado_em', null], ['order', 'created_at', { ascending: false }], ['limit', 1],
    ]);
  });

  it('sem envio: null; escopo inválido, erro ou formato inesperado falham fechado', async () => {
    await expect(lerUltimoEnvioPublicoDaConversa(gravador({ data: [], error: null }).cliente, ESCOPO, CONVERSA)).resolves.toBeNull();
    const semConsulta = gravador({ data: [], error: null });
    await expect(lerUltimoEnvioPublicoDaConversa(semConsulta.cliente, ESCOPO, 'x')).rejects.toBeInstanceOf(RegistroDeEnvioIndisponivel);
    expect(semConsulta.chamadas).toEqual([]);
    await expect(lerUltimoEnvioPublicoDaConversa(gravador({ data: null, error: { code: '42501' } }).cliente, ESCOPO, CONVERSA))
      .rejects.toBeInstanceOf(RegistroDeEnvioIndisponivel);
    await expect(lerUltimoEnvioPublicoDaConversa(gravador({ data: [{ created_at: 'ontem' }], error: null }).cliente, ESCOPO, CONVERSA))
      .rejects.toBeInstanceOf(RegistroDeEnvioIndisponivel);
  });
});
