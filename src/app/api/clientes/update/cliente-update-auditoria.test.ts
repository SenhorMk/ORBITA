import { describe, expect, it } from 'vitest';

import { createClienteUpdateHandler, type ClienteBlingPort, type ClienteDependencies } from './handler';
import { buildClienteRequest } from '@/lib/config/clienteContract';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import type { EventoComercial } from '@/services/auditoriaComercial';

/**
 * PRE-006C: a gravação do contato deixa trilha persistente com o desfecho
 * real — concluído, recusado, desconhecido ou parcial —, com ator e
 * organização do escopo verificado e sem nome, documento, e-mail ou telefone.
 */

const ORG = '11111111-1111-4111-8111-111111111111';
const ACTOR = '22222222-2222-4222-8222-222222222222';
const CLIENTE = '33333333-3333-4333-8333-333333333333';
/** SAFETY: o escopo é entrada do teste, não o que está sob teste. */
const scope = { organizationId: ORG, actorId: ACTOR, role: 'owner' } as unknown as VerifiedOrganizationScope;

type Resposta = Awaited<ReturnType<ClienteBlingPort['criar']>>;
const ok: Resposta = { _tag: 'BlingOk', value: { id: '5150' } };
const falha = (type: string, status: number): Resposta => ({
  _tag: 'BlingFailed', failure: { _tag: 'BlingProviderFailure', type, status, message: 'x', duplicateSale: false },
});

function montar(options: { criar?: () => Promise<Resposta>; gravarFalha?: boolean } = {}) {
  const eventos: Array<{ organizationId: string; actorId: string; evento: EventoComercial }> = [];
  const deps: ClienteDependencies = {
    auth: { async authorize() { return { _tag: 'Authorized', scope }; } },
    bling: {
      criar: options.criar ?? (async () => ok),
      async atualizar() { return { _tag: 'BlingOk', value: undefined }; },
    },
    store: {
      async upsert(_s, c) {
        if (options.gravarFalha) throw Object.assign(new Error('falhou'), { code: '23505' });
        return { id: CLIENTE, blingId: c.blingId, nome: c.nome };
      },
      async exclusaoVigenteNoBling() { return false; },
    },
    async auditar(s, evento) { eventos.push({ organizationId: s.organizationId, actorId: s.actorId, evento }); },
    correlationId: () => 'corr_cli',
  };
  return { eventos, handler: createClienteUpdateHandler(deps) };
}

const pedido = (corpo: unknown) => new Request('https://orbita.test/api/clientes/update', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo),
});
const novo = () => pedido(buildClienteRequest({
  nome: 'Ana Souza', email: 'ana@exemplo.com', telefone: '4899990000', cpfCnpj: '12345678909', tipo: 'F', indicadorIe: 9,
}));

describe('auditoria da gravação de contato (PRE-006C)', () => {
  it('concluído: ator e organização verificados, sem dado pessoal na metadata', async () => {
    const { eventos, handler } = montar();

    expect((await handler(novo())).status).toBe(200);

    expect(eventos).toEqual([{
      organizationId: ORG,
      actorId: ACTOR,
      evento: {
        acao: 'customer.contact_saved', recurso: 'cliente', recursoId: CLIENTE, correlationId: 'corr_cli',
        metadata: { cliente_id: CLIENTE, bling_id: '5150', operacao: 'cadastro' },
      },
    }]);
    expect(JSON.stringify(eventos)).not.toMatch(/Ana|ana@exemplo|4899990000|12345678909/u);
  });

  it('recusa comprovada do Bling (4xx): evento de recusa', async () => {
    const { eventos, handler } = montar({ criar: async () => falha('VALIDATION_ERROR', 400) });

    expect((await handler(novo())).status).toBe(400);
    expect(eventos.map((e) => e.evento)).toEqual([{
      acao: 'customer.contact_save_rejected', recurso: 'cliente', recursoId: null, correlationId: 'corr_cli',
      metadata: { operacao: 'cadastro', status_http: 400 },
    }]);
  });

  it('5xx, timeout ou exceção: desconhecido, nunca recusa', async () => {
    for (const criar of [async () => falha('SERVER_ERROR', 503), async (): Promise<Resposta> => { throw new TypeError('fetch failed'); }]) {
      const { eventos, handler } = montar({ criar });

      expect((await handler(novo())).status).toBe(502);
      expect(eventos.map((e) => e.evento.acao)).toEqual(['customer.contact_save_reconcile_required']);
      expect(eventos[0]!.evento.metadata).toEqual({ operacao: 'cadastro', motivo: 'bling_sem_confirmacao', bling_id: null });
    }
  });

  it('Bling confirmou e o espelho falhou: parcial, com o id do Bling', async () => {
    const { eventos, handler } = montar({ gravarFalha: true });

    expect((await handler(novo())).status).toBe(500);
    expect(eventos.map((e) => e.evento)).toEqual([{
      acao: 'customer.contact_save_reconcile_required', recurso: 'cliente', recursoId: null, correlationId: 'corr_cli',
      metadata: { operacao: 'cadastro', motivo: 'espelho_local_falhou', bling_id: '5150' },
    }]);
  });

  it('entrada inválida é recusada antes de qualquer efeito, sem evento', async () => {
    let chamadas = 0;
    const { eventos, handler } = montar({ criar: async () => { chamadas += 1; return ok; } });

    expect((await handler(pedido({ nome: '', organizacaoId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }))).status).toBe(400);
    expect(chamadas).toBe(0);
    expect(eventos).toEqual([]);
  });
});
