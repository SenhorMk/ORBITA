import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ControleIndisponivel, lerUltimaDevolucaoDaConversa } from './controleAtendimento';

const ORG = 'c75eb92d-9222-49cc-ac0f-6aebaf8fa69f';
const CONVERSA = '22222222-2222-4222-8222-222222222222';

function gravador(resposta: { data: unknown; error: unknown }) {
  const chamadas: unknown[][] = [];
  const cadeia: Record<string, unknown> = {};
  for (const metodo of ['select', 'eq', 'order', 'limit']) {
    cadeia[metodo] = (...args: unknown[]) => { chamadas.push([metodo, ...args]); return cadeia; };
  }
  cadeia.then = (resolver: (v: unknown) => void) => resolver(resposta);
  const cliente = { from: (tabela: string) => { chamadas.push(['from', tabela]); return cadeia; } } as unknown as SupabaseClient;
  return { cliente, chamadas };
}

describe('última devolução à automação (corte do assistente)', () => {
  it('só a ação devolver, da organização e da conversa; lê só o instante', async () => {
    const { cliente, chamadas } = gravador({ data: [{ created_at: '2026-11-23T15:08:20.000+00:00' }], error: null });
    await expect(lerUltimaDevolucaoDaConversa(cliente, ORG, CONVERSA)).resolves.toBe('2026-11-23T15:08:20.000+00:00');
    expect(chamadas).toEqual([
      ['from', 'chatwoot_controle_historico'], ['select', 'created_at'],
      ['eq', 'organizacao_id', ORG], ['eq', 'conversa_id_local', CONVERSA], ['eq', 'acao', 'devolver'],
      ['order', 'created_at', { ascending: false }], ['limit', 1],
    ]);
  });

  it('sem devolução: null; escopo inválido, erro ou formato inesperado falham fechado', async () => {
    await expect(lerUltimaDevolucaoDaConversa(gravador({ data: [], error: null }).cliente, ORG, CONVERSA)).resolves.toBeNull();
    const semConsulta = gravador({ data: [], error: null });
    await expect(lerUltimaDevolucaoDaConversa(semConsulta.cliente, 'x', CONVERSA)).rejects.toBeInstanceOf(ControleIndisponivel);
    expect(semConsulta.chamadas).toEqual([]);
    await expect(lerUltimaDevolucaoDaConversa(gravador({ data: null, error: { code: '42501' } }).cliente, ORG, CONVERSA))
      .rejects.toBeInstanceOf(ControleIndisponivel);
    await expect(lerUltimaDevolucaoDaConversa(gravador({ data: [{ created_at: 'ontem' }], error: null }).cliente, ORG, CONVERSA))
      .rejects.toBeInstanceOf(ControleIndisponivel);
  });
});
