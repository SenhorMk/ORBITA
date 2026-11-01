import { describe, expect, it, vi } from 'vitest';

import type { OrganizationContextResult } from '@/lib/organizationAuthorization';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import { listarCasos, listarEventosRecebidos } from '@/services/sac/leituraDeCasos';
import type { SupabaseClient } from '@supabase/supabase-js';

import { criarConsultaDeCasos, type DependenciasDosCasos } from './handlers';

const ORG_A = '22222222-2222-4222-8222-222222222222';
const USUARIO = '70000000-0000-4000-8000-000000000001';
const EVENTO = '11111111-1111-4111-8111-111111111111';
const CASO = '33333333-3333-4333-8333-333333333333';
const CONVERSA = '44444444-4444-4444-8444-444444444444';

function sessao(capabilities: readonly string[]): OrganizationContextResult {
  return {
    _tag: 'OrganizationContextResolved',
    context: { userId: USUARIO, organizationId: ORG_A, role: 'member', capabilities: new Set(capabilities) },
  } as unknown as OrganizationContextResult;
}

function deps(contexto: OrganizationContextResult) {
  return {
    resolverContexto: vi.fn(async () => contexto),
    listarEventos: vi.fn(async () => [{
      id: EVENTO, tipo: 'message_created', estado: 'processada' as const, disposicao: 'caso_aberto', motivo: null,
      tentativas: 1, casoId: CASO, recebidaEm: '2026-11-01T00:00:00Z', processadaEm: '2026-11-01T00:00:01Z',
    }]),
    listarCasos: vi.fn(async () => [{
      id: CASO, fase: 'TRIAGE', versao: 1, conversaIdLocal: CONVERSA, abertoEm: '2026-11-01T00:00:01Z', ultimaMensagemEm: '2026-11-01T00:00:00Z',
    }]),
  } satisfies DependenciasDosCasos;
}

describe('GET /api/sac/casos', () => {
  it('a organização vem da sessão: o parâmetro do cliente não é autoridade', async () => {
    const d = deps(sessao(['organization:access']));
    const res = await criarConsultaDeCasos(d)(new Request(`https://orbita.test/api/sac/casos?organizacao=outra`));
    const corpo = await res.json();

    expect(res.status).toBe(200);
    expect(d.listarEventos).toHaveBeenCalledWith(expect.objectContaining({ organizationId: ORG_A }));
    expect(d.listarCasos).toHaveBeenCalledWith(expect.objectContaining({ organizationId: ORG_A }));
    expect(corpo.versao).toBe(1);
    expect(corpo.eventos[0]).toMatchObject({ estado: 'processada', disposicao: 'caso_aberto', casoId: CASO });
    expect(corpo.casos[0]).toMatchObject({ fase: 'TRIAGE' });
    expect(JSON.stringify(corpo)).not.toMatch(/payload|content|phone/u);
  });

  it('sem sessão, sem vínculo ou autorização fora: nega e não consulta', async () => {
    for (const [tag, esperado] of [['SessionMissing', 401], ['OrganizationAccessDenied', 403], ['OrganizationStoreUnavailable', 503]] as const) {
      const d = deps({ _tag: tag } as OrganizationContextResult);
      const res = await criarConsultaDeCasos(d)(new Request('https://orbita.test/api/sac/casos'));
      expect(res.status).toBe(esperado);
      expect(d.listarEventos).not.toHaveBeenCalled();
      expect(d.listarCasos).not.toHaveBeenCalled();
    }
  });

  it('sem a capability de acesso: 403 e nada consultado', async () => {
    const d = deps(sessao([]));
    const res = await criarConsultaDeCasos(d)(new Request('https://orbita.test/api/sac/casos'));
    expect(res.status).toBe(403);
    expect(d.listarEventos).not.toHaveBeenCalled();
  });

  it('a rota só exporta GET: nenhum método aciona o consumidor', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project-ref.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'public-key-12345678901234567890';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'server-key-12345678901234567890';
    const rota = await import('./route');
    expect(Object.keys(rota).filter((k) => /^(GET|POST|PUT|PATCH|DELETE)$/u.test(k))).toEqual(['GET']);
  });
});

describe('leitura privilegiada: filtra a organização mesmo sem RLS', () => {
  const ESCOPO = { organizationId: ORG_A, actorId: USUARIO } as VerifiedOrganizationScope;

  function clienteQueGuarda(linhas: unknown[]) {
    const filtros: Array<[string, unknown]> = [];
    let colunas = '';
    const consulta = {
      select(c: string) { colunas = c; return consulta; },
      eq(col: string, val: unknown) { filtros.push([col, val]); return consulta; },
      order() { return consulta; },
      limit() { return Promise.resolve({ data: linhas, error: null }); },
    };
    return { cliente: { from: () => consulta } as unknown as SupabaseClient, filtros, colunas: () => colunas };
  }

  it('eventos: filtro por organização, sem selecionar o payload; erro antigo não vaza como texto', async () => {
    const c = clienteQueGuarda([{
      id: EVENTO, event_type: 'message_created', status: 'failed', disposicao: null,
      last_error: 'erro com telefone +5511999990001', attempts: 2, caso_id: null, created_at: 'x', processed_at: null,
    }]);
    const [evento] = await listarEventosRecebidos(c.cliente, ESCOPO);
    expect(c.filtros).toContainEqual(['organizacao_id', ORG_A]);
    expect(c.colunas()).not.toContain('payload');
    expect(evento).toMatchObject({ estado: 'falha_com_retentativa', motivo: 'erro_legado' });
  });

  it('falha definitiva é um estado à parte; código técnico passa', async () => {
    const c = clienteQueGuarda([{
      id: EVENTO, event_type: 'message_created', status: 'failed', disposicao: 'falha_definitiva',
      last_error: 'payload_invalido', attempts: 1, caso_id: null, created_at: 'x', processed_at: null,
    }]);
    const [evento] = await listarEventosRecebidos(c.cliente, ESCOPO);
    expect(evento).toMatchObject({ estado: 'falha_definitiva', motivo: 'payload_invalido' });
  });

  it('casos: filtro por organização', async () => {
    const c = clienteQueGuarda([]);
    await listarCasos(c.cliente, ESCOPO);
    expect(c.filtros).toContainEqual(['organizacao_id', ORG_A]);
  });
});
