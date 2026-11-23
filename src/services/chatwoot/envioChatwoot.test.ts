import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import type { VerifiedOrganizationScope } from '../../lib/verifiedOrganizationScope';
import { lerUltimoEnvioConfirmadoDaConversa, listarEnviosDaConversa, provaDoEnvio, RegistroDeEnvioIndisponivel } from './envioChatwoot';

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

describe('envio como prova de atendimento (corte do assistente)', () => {
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
  const linha = (segundos: number, status: string, invalidado = false) => ({
    created_at: new Date(Date.UTC(2026, 10, 23, 15, 0, segundos)).toISOString(),
    invalidado_em: invalidado ? '2026-11-23T15:10:00.000Z' : null,
    outbox_eventos: { status },
  });

  it.each([
    ['sent', 'confirmado'],
    ['pending', 'registrado'], ['processing', 'registrado'], ['failed_transient', 'registrado'], ['in_flight', 'registrado'],
    ['dead_letter', 'nao_entregue'], ['unknown', 'desconhecido'], ['estado_novo', 'desconhecido'],
  ])('outbox %s → %s', (status, prova) => {
    expect(provaDoEnvio({ status, invalidadoEm: null })).toBe(prova);
  });

  it('invalidado por mudança de responsável nunca prova entrega, mesmo marcado como sent', () => {
    expect(provaDoEnvio({ status: 'sent', invalidadoEm: '2026-11-23T15:10:00Z' })).toBe('nao_entregue');
  });

  it('lê instante e estado dos envios públicos da organização, conexão e conversa, sem filtrar estado no PostgREST', async () => {
    const { cliente, chamadas } = gravador({ data: [linha(12, 'sent')], error: null });
    await expect(lerUltimoEnvioConfirmadoDaConversa(cliente, ESCOPO, CONVERSA)).resolves.toBe(linha(12, 'sent').created_at);
    expect(chamadas).toEqual([
      ['from', 'chatwoot_envios'], ['select', 'created_at, invalidado_em, outbox_eventos!fk_chatwoot_envios_evento(status)'],
      ['eq', 'organizacao_id', ESCOPO.organizacaoId], ['eq', 'conexao_id', ESCOPO.conexaoId], ['eq', 'conversa_id_local', CONVERSA],
      ['eq', 'privada', false], ['order', 'created_at', { ascending: false }], ['limit', 20],
    ]);
  });

  it.each(['pending', 'processing', 'failed_transient', 'in_flight', 'dead_letter', 'unknown'])(
    'resposta mais recente em %s não vira corte: vale a última confirmada antes dela', async (status) => {
      const { cliente } = gravador({ data: [linha(40, status), linha(10, 'sent')], error: null });
      await expect(lerUltimoEnvioConfirmadoDaConversa(cliente, ESCOPO, CONVERSA)).resolves.toBe(linha(10, 'sent').created_at);
    });

  it('dead_letter sem invalidado_em, registrada sem confirmação ou invalidada: sem confirmada, nenhum corte', async () => {
    const { cliente } = gravador({ data: [linha(40, 'dead_letter'), linha(30, 'unknown'), linha(20, 'sent', true), linha(10, 'pending')], error: null });
    await expect(lerUltimoEnvioConfirmadoDaConversa(cliente, ESCOPO, CONVERSA)).resolves.toBeNull();
  });

  it('escopo inválido, erro ou formato inesperado falham fechado, sem consulta ou dado parcial', async () => {
    const semConsulta = gravador({ data: [], error: null });
    await expect(lerUltimoEnvioConfirmadoDaConversa(semConsulta.cliente, ESCOPO, 'x')).rejects.toBeInstanceOf(RegistroDeEnvioIndisponivel);
    expect(semConsulta.chamadas).toEqual([]);
    await expect(lerUltimoEnvioConfirmadoDaConversa(gravador({ data: null, error: { code: '42501' } }).cliente, ESCOPO, CONVERSA))
      .rejects.toBeInstanceOf(RegistroDeEnvioIndisponivel);
    await expect(lerUltimoEnvioConfirmadoDaConversa(gravador({ data: [{ created_at: 'ontem', invalidado_em: null, outbox_eventos: { status: 'sent' } }], error: null }).cliente, ESCOPO, CONVERSA))
      .rejects.toBeInstanceOf(RegistroDeEnvioIndisponivel);
    await expect(lerUltimoEnvioConfirmadoDaConversa(gravador({ data: [{ created_at: linha(1, 'sent').created_at, invalidado_em: null }], error: null }).cliente, ESCOPO, CONVERSA))
      .rejects.toBeInstanceOf(RegistroDeEnvioIndisponivel);
  });
});
