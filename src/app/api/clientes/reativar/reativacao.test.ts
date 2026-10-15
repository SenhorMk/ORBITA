import { NextResponse } from 'next/server';
import { describe, expect, it } from 'vitest';

import { respostaDaReativacaoSchema } from '@/lib/config/reativacaoDeContatoContract';
import type { ContatoRemoto, LeituraRemota } from '@/lib/integrations/bling/operacaoRemotaContract';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';

import { createReativacaoDeContatoHandler, type EventoDeReativacao } from './handler';

/**
 * PRE-005: a reativação explícita é o único caminho de volta de um contato
 * excluído no Bling. Só reativa com o contato provado ativo no Bling, e só
 * para quem administra a organização.
 */

/** SAFETY: o escopo é entrada do teste, não o que está sob teste. */
const scope = { organizationId: '11111111-1111-4111-8111-111111111111', actorId: '22222222-2222-4222-8222-222222222222', role: 'owner' } as unknown as VerifiedOrganizationScope;

function montar(opcoes: {
  autorizado?: boolean;
  vigente?: boolean;
  leitura?: LeituraRemota<ContatoRemoto>;
  desfecho?: 'reativado' | 'nao_excluido' | 'negado';
  auditoriaCai?: boolean;
} = {}) {
  const reativados: Array<{ org: string; blingId: string }> = [];
  const lidos: string[] = [];
  const auditados: EventoDeReativacao[] = [];
  const handler = createReativacaoDeContatoHandler({
    autorizar: async () => (opcoes.autorizado ?? true
      ? { _tag: 'Autorizado', scope }
      : { _tag: 'Negado', response: NextResponse.json({ success: false }, { status: 403 }) }),
    store: {
      async exclusaoVigenteNoBling() { return opcoes.vigente ?? true; },
      async reativarExcluidoNoBling(s, blingId) { reativados.push({ org: s.organizationId, blingId }); return opcoes.desfecho ?? 'reativado'; },
    },
    bling: () => ({
      async consultarContato(id) { lidos.push(id); return opcoes.leitura ?? { _tag: 'RemotoPresente', valor: { id, situacao: 'A' } }; },
    }),
    auditar: async (_s, evento) => {
      if (opcoes.auditoriaCai) throw new Error('auditoria fora');
      auditados.push(evento);
    },
    correlationId: () => 'corr-1',
  });
  return { handler, reativados, lidos, auditados };
}

const pedido = (corpo: unknown) => new Request('https://orbita.test/api/clientes/reativar', { method: 'POST', body: JSON.stringify(corpo) });

async function chamar(montado: ReturnType<typeof montar>, corpo: unknown = { blingId: '17000000001' }) {
  const resposta = await montado.handler(pedido(corpo));
  return { status: resposta.status, corpo: await resposta.json() };
}

describe('reativação explícita de contato excluído no Bling (PRE-005)', () => {
  it('contato ativo no Bling: reativa no escopo verificado e audita', async () => {
    const m = montar();
    const r = await chamar(m);

    expect(r).toEqual({ status: 200, corpo: { resultado: 'Reactivated' } });
    expect(respostaDaReativacaoSchema.parse(r.corpo)).toEqual({ resultado: 'Reactivated' });
    expect(m.reativados).toEqual([{ org: scope.organizationId, blingId: '17000000001' }]);
    expect(m.auditados).toEqual([expect.objectContaining({ acao: 'customer.contact_reactivated', recursoId: '17000000001' })]);
  });

  it('sem capacidade: a recusa da autorização volta intacta e nada é lido nem reativado', async () => {
    const m = montar({ autorizado: false });
    const r = await chamar(m);

    expect(r.status).toBe(403);
    expect(m.lidos).toEqual([]);
    expect(m.reativados).toEqual([]);
  });

  it('o banco recusa o ator que não administra a organização: Forbidden', async () => {
    const m = montar({ desfecho: 'negado' });
    const r = await chamar(m);

    expect(r).toEqual({ status: 403, corpo: { resultado: 'Forbidden' } });
    expect(m.auditados).toEqual([]);
  });

  it.each([
    ['ausente (404)', { _tag: 'RemotoAusente' } as const, 409, { resultado: 'Blocked', motivo: 'ainda_excluido_no_bling' }],
    ['na lixeira (situação E)', { _tag: 'RemotoPresente', valor: { id: '17000000001', situacao: 'E' } } as const, 409, { resultado: 'Blocked', motivo: 'ainda_excluido_no_bling' }],
    ['sem situação na leitura', { _tag: 'RemotoPresente', valor: { id: '17000000001' } } as const, 503, { resultado: 'ReconcileRequired' }],
    ['leitura indeterminada', { _tag: 'RemotoIndeterminado', causa: 'prazo_esgotado' } as const, 503, { resultado: 'ReconcileRequired' }],
    ['recusada pelo Bling', { _tag: 'RemotoRecusou', status: 401 } as const, 502, { resultado: 'ProviderRefused', motivo: 'recusado_pelo_bling' }],
    ['limitada', { _tag: 'RemotoLimitado' } as const, 502, { resultado: 'ProviderRefused', motivo: 'limite_de_requisicoes' }],
  ])('contato %s no Bling: nada é reativado', async (_caso, leitura, status, corpo) => {
    const m = montar({ leitura });
    const r = await chamar(m);

    expect(r).toEqual({ status, corpo });
    expect(m.reativados).toEqual([]);
  });

  it('sem exclusão vigente: NotExcluded, sem ler o Bling', async () => {
    const m = montar({ vigente: false });
    const r = await chamar(m);

    expect(r).toEqual({ status: 200, corpo: { resultado: 'NotExcluded' } });
    expect(m.lidos).toEqual([]);
  });

  it.each([[{ blingId: 'temp_ab12' }], [{ blingId: 17000000001 }], [{}]])('corpo inválido %j: nada é lido', async (corpo) => {
    const m = montar();
    const r = await chamar(m, corpo);

    expect(r).toEqual({ status: 400, corpo: { resultado: 'InvalidRequest' } });
    expect(m.lidos).toEqual([]);
  });

  it('auditoria que cai depois da reativação não vira falha', async () => {
    const m = montar({ auditoriaCai: true });
    const r = await chamar(m);

    expect(r).toEqual({ status: 200, corpo: { resultado: 'Reactivated' } });
  });
});
