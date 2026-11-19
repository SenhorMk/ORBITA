import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import type { OrganizationContextResult } from '@/lib/organizationAuthorization';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import { lerTriagemDoCaso, TriagemIndisponivel, type LeituraDaTriagem } from '@/services/sac/leituraDaTriagem';

import { criarRotaDaTriagem, type DependenciasDaTriagem } from './handlers';

const ORG_A = '22222222-2222-4222-8222-222222222222';
const ORG_B = '99999999-9999-4999-8999-999999999999';
const USUARIO = '70000000-0000-4000-8000-000000000001';
const CONVERSA = '44444444-4444-4444-8444-444444444444';
const CASO = '55555555-5555-4555-8555-555555555555';
const URL = 'https://orbita.test/api/sac/triagem';
const TRIAGEM = {
  versao: 1, intencao: 'rastrear_pedido', motivo: 'Pedido atrasado.', confianca: 'alta', numeroDoPedido: '1001',
  resolucaoPedida: 'informacao', entidades: [], informacoesFaltando: [], proximaPergunta: null, precisaDeHumano: false, motivoDoHumano: null,
};

function sessao(capabilities: readonly string[]): OrganizationContextResult {
  return {
    _tag: 'OrganizationContextResolved',
    context: { actorId: USUARIO, organizationId: ORG_A, role: 'member', capabilities: new Set(capabilities) },
  } as unknown as OrganizationContextResult;
}

const lida: LeituraDaTriagem = {
  _tag: 'Lida',
  caso: { id: CASO, fase: 'TRIAGE', pendente: false, execucao: {
    status: 'concluida', motivo: null, triagem: TRIAGEM as never, provedor: 'google', modelo: 'gemini-2.5-flash',
    criadaEm: '2026-11-12T10:00:00Z', concluidaEm: '2026-11-12T10:00:02Z',
  } },
};

function deps(contexto: OrganizationContextResult, leitura: LeituraDaTriagem = lida) {
  return { resolverContexto: vi.fn(async () => contexto), ler: vi.fn<DependenciasDaTriagem['ler']>(async () => leitura) };
}

describe('GET /api/sac/triagem', () => {
  it('a organização vem da sessão; o corpo segue o contrato', async () => {
    const d = deps(sessao(['organization:access']));
    const res = await criarRotaDaTriagem(d)(new Request(`${URL}?conversaId=${CONVERSA}&organizacaoId=${ORG_B}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, versao: 1, caso: lida.caso });
    expect(d.ler).toHaveBeenCalledWith(expect.objectContaining({ organizationId: ORG_A }), CONVERSA);
  });

  it('sem sessão, sem vínculo, autorização fora ou sem capability: nega sem ler', async () => {
    for (const [contexto, status] of [
      [{ _tag: 'SessionMissing' }, 401], [{ _tag: 'OrganizationAccessDenied' }, 403], [{ _tag: 'OrganizationStoreUnavailable' }, 503],
    ] as const) {
      const d = deps(contexto as OrganizationContextResult);
      expect((await criarRotaDaTriagem(d)(new Request(`${URL}?conversaId=${CONVERSA}`))).status).toBe(status);
      expect(d.ler).not.toHaveBeenCalled();
    }
    const semCapacidade = deps(sessao([]));
    expect((await criarRotaDaTriagem(semCapacidade)(new Request(`${URL}?conversaId=${CONVERSA}`))).status).toBe(403);
    expect(semCapacidade.ler).not.toHaveBeenCalled();
  });

  it('conversa inválida: 400; de outra organização: 404; banco fora: 503', async () => {
    const d = deps(sessao(['organization:access']));
    expect((await criarRotaDaTriagem(d)(new Request(`${URL}?conversaId=90`))).status).toBe(400);
    expect(d.ler).not.toHaveBeenCalled();
    expect((await criarRotaDaTriagem(deps(sessao(['organization:access']), { _tag: 'ConversaNaoEncontrada' }))(new Request(`${URL}?conversaId=${CONVERSA}`))).status).toBe(404);
    const fora = deps(sessao(['organization:access']));
    fora.ler.mockRejectedValue(new TriagemIndisponivel());
    expect((await criarRotaDaTriagem(fora)(new Request(`${URL}?conversaId=${CONVERSA}`))).status).toBe(503);
  });
});

const ESCOPO = { organizationId: ORG_A, actorId: USUARIO, role: 'member' } as VerifiedOrganizationScope;
const banco = (data: unknown, error: unknown = null) => ({ rpc: vi.fn(async () => ({ data, error })) }) as unknown as SupabaseClient;
const execucao = (campos: Record<string, unknown>) => ({
  resultado: 'caso', caso_id: CASO, fase: 'TRIAGE', pendente: false,
  execucao: { status: 'concluida', motivo: null, resultado: TRIAGEM, provedor: 'google', modelo: 'gemini-2.5-flash', versao_schema: 1,
    criada_em: '2026-11-12T10:00:00Z', concluida_em: '2026-11-12T10:00:02Z', ...campos },
});

describe('lerTriagemDoCaso', () => {
  it('concluída: triagem; obsoleta: sem triagem, só o status', async () => {
    const concluida = await lerTriagemDoCaso(banco(execucao({})), ESCOPO, CONVERSA);
    expect(concluida._tag === 'Lida' && concluida.caso?.execucao?.triagem?.intencao).toBe('rastrear_pedido');
    const obsoleta = await lerTriagemDoCaso(banco(execucao({ status: 'obsoleta', motivo: 'caso_mudou' })), ESCOPO, CONVERSA);
    expect(obsoleta._tag === 'Lida' && obsoleta.caso?.execucao).toMatchObject({ status: 'obsoleta', triagem: null });
  });

  it('sem caso e conversa alheia', async () => {
    expect(await lerTriagemDoCaso(banco({ resultado: 'sem_caso' }), ESCOPO, CONVERSA)).toEqual({ _tag: 'Lida', caso: null });
    expect(await lerTriagemDoCaso(banco({ resultado: 'conversa_inexistente' }), ESCOPO, CONVERSA)).toEqual({ _tag: 'ConversaNaoEncontrada' });
  });

  it('resultado gravado fora do schema ou erro do banco: indisponível', async () => {
    await expect(lerTriagemDoCaso(banco(execucao({ resultado: { intencao: 'pizza' } })), ESCOPO, CONVERSA)).rejects.toBeInstanceOf(TriagemIndisponivel);
    await expect(lerTriagemDoCaso(banco(null, { code: '57014' }), ESCOPO, CONVERSA)).rejects.toBeInstanceOf(TriagemIndisponivel);
  });
});
