import { describe, expect, it, vi } from 'vitest';

import type { OrganizationContextResult } from '@/lib/organizationAuthorization';
import type { DecisaoOutbox, EventoComAtencao } from '@/services/outbox/decisoesDaOutbox';

import { criarConsultaDaOutbox, criarDecisaoDaOutbox, type DependenciasDaOutbox } from './handlers';

/**
 * MSG-007: a consulta de tentativas e as decisões sobre um efeito desconhecido.
 * A organização vem só da sessão; decidir exige `organization:manage` (e o
 * banco confere o papel de novo); replay só depois de provada a não aplicação.
 */

const ORG_A = '22222222-2222-4222-8222-222222222222';
const EVENTO = '11111111-1111-4111-8111-111111111111';

function sessao(capabilities: string[], organizationId = ORG_A): OrganizationContextResult {
  return {
    _tag: 'OrganizationContextResolved',
    context: { actorId: 'a0000000-0000-4000-8000-000000000001', organizationId, role: 'owner', capabilities: new Set(capabilities) },
  } as unknown as OrganizationContextResult;
}

const desconhecido: EventoComAtencao = {
  id: EVENTO, destino: 'chatwoot', tipo: 'message.send', status: 'unknown', desfecho: 'desconhecido',
  motivoBloqueio: 'timeout', resolucao: null, tentativasContadas: 1, podeRepetir: false,
  explicacao: 'O provedor não respondeu a tempo. Não reenvie.', atualizadoEm: '2026-10-26T00:00:00Z',
  tentativas: [{ fencingToken: 1, desfecho: 'desconhecido', motivo: 'timeout', iniciadaEm: 'x', concluidaEm: 'y' }],
};

function deps(contexto: OrganizationContextResult, decisao: DecisaoOutbox = { _tag: 'DecisaoAplicada', status: 'pending' }) {
  return {
    resolverContexto: vi.fn(async () => contexto),
    listar: vi.fn(async () => [desconhecido]),
    autorizarReplay: vi.fn(async () => decisao),
    resolver: vi.fn(async () => decisao),
    auditar: vi.fn(async () => {}),
  } satisfies DependenciasDaOutbox;
}

const pedir = (corpo: unknown, url = `https://orbita.test/api/integracoes/outbox/${EVENTO}`) =>
  new Request(url, { method: 'POST', body: JSON.stringify(corpo) });

describe('GET /api/integracoes/outbox', () => {
  it('lista só a organização da sessão, com motivo, tentativas e sem payload', async () => {
    const d = deps(sessao(['organization:access']));
    const res = await criarConsultaDaOutbox(d)(new Request('https://orbita.test/api/integracoes/outbox?organizacao=outra'));
    const corpo = await res.json();

    expect(res.status).toBe(200);
    expect(d.listar).toHaveBeenCalledWith(expect.objectContaining({ organizationId: ORG_A }));
    expect(corpo.versao).toBe(1);
    expect(corpo.eventos[0]).toMatchObject({ podeRepetir: false, motivoBloqueio: 'timeout', tentativas: [{ fencingToken: 1 }] });
    expect(JSON.stringify(corpo)).not.toMatch(/payload|content/u);
  });

  it('sem sessão ou sem vínculo: nega e não consulta', async () => {
    for (const [tag, esperado] of [['SessionMissing', 401], ['OrganizationAccessDenied', 403], ['OrganizationStoreUnavailable', 503]] as const) {
      const d = deps({ _tag: tag } as OrganizationContextResult);
      const res = await criarConsultaDaOutbox(d)(new Request('https://orbita.test/api/integracoes/outbox'));
      expect(res.status).toBe(esperado);
      expect(d.listar).not.toHaveBeenCalled();
    }
  });
});

describe('POST /api/integracoes/outbox/[eventoId]', () => {
  it('membro sem capability de gestão: 403, sem decisão nem auditoria', async () => {
    const d = deps(sessao(['organization:access']));
    const res = await criarDecisaoDaOutbox(d)(pedir({ acao: 'replay' }), EVENTO);
    expect(res.status).toBe(403);
    expect(d.autorizarReplay).not.toHaveBeenCalled();
    expect(d.auditar).not.toHaveBeenCalled();
  });

  it('entrada inválida: id que não é UUID, ação desconhecida, prova sem evidência — 400', async () => {
    const d = deps(sessao(['organization:access', 'organization:manage']));
    const decidir = criarDecisaoDaOutbox(d);
    expect((await decidir(pedir({ acao: 'replay' }), 'nao-e-uuid')).status).toBe(400);
    expect((await decidir(pedir({ acao: 'forcar' }), EVENTO)).status).toBe(400);
    expect((await decidir(pedir({ acao: 'reconciliar', resolucao: 'provado_nao_aplicado', evidencia: 'curta' }), EVENTO)).status).toBe(400);
    expect((await decidir(pedir({ acao: 'reconciliar', resolucao: 'confirmado' }), EVENTO)).status).toBe(400);
    expect(d.autorizarReplay).not.toHaveBeenCalled();
    expect(d.resolver).not.toHaveBeenCalled();
  });

  it('replay bloqueado (sem prova de não aplicação): 409 com a razão, auditado como recusa', async () => {
    const d = deps(sessao(['organization:access', 'organization:manage']), { _tag: 'DecisaoRecusada', falha: 'EstadoNaoAdmite' });
    const res = await criarDecisaoDaOutbox(d)(pedir({ acao: 'replay' }), EVENTO);
    const corpo = await res.json();
    expect(res.status).toBe(409);
    expect(corpo.error).toMatch(/não pode ser repetido/u);
    expect(d.auditar).toHaveBeenCalledWith(expect.anything(), 'outbox.replay_refused', EVENTO, { acao: 'replay', falha: 'EstadoNaoAdmite' });
  });

  it('replay elegível: aplicado no escopo da sessão e auditado', async () => {
    const d = deps(sessao(['organization:access', 'organization:manage']));
    const res = await criarDecisaoDaOutbox(d)(pedir({ acao: 'replay', organizacaoId: 'outra-org' }), EVENTO);
    expect(res.status).toBe(200);
    expect(d.autorizarReplay).toHaveBeenCalledWith(expect.objectContaining({ organizationId: ORG_A }), EVENTO);
    expect(d.auditar).toHaveBeenCalledWith(expect.anything(), 'outbox.replay_authorized', EVENTO, { acao: 'replay', status: 'pending' });
  });

  it('reconciliação com recibo: a evidência e o recibo não vão para a auditoria', async () => {
    const d = deps(sessao(['organization:access', 'organization:manage']), { _tag: 'DecisaoAplicada', status: 'sent' });
    const res = await criarDecisaoDaOutbox(d)(pedir({ acao: 'reconciliar', resolucao: 'confirmado', reciboRef: '4242', evidencia: 'visto' }), EVENTO);
    expect(res.status).toBe(200);
    expect(d.resolver).toHaveBeenCalledWith(expect.objectContaining({ organizationId: ORG_A }), EVENTO,
      { resolucao: 'confirmado', reciboRef: '4242', evidencia: 'visto' });
    expect(d.auditar).toHaveBeenCalledWith(expect.anything(), 'outbox.effect_reconciled', EVENTO,
      { acao: 'reconciliar', status: 'sent', resolucao: 'confirmado' });
  });

  it('evento de outra organização: o banco não encontra no escopo da sessão — 404', async () => {
    const d = deps(sessao(['organization:access', 'organization:manage']), { _tag: 'DecisaoRecusada', falha: 'NaoEncontrado' });
    const res = await criarDecisaoDaOutbox(d)(pedir({ acao: 'replay' }), EVENTO);
    expect(res.status).toBe(404);
  });
});
