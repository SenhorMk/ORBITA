import { NextResponse } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

import type { ExclusaoRemota, LeituraRemota, ContatoRemoto } from '@/lib/integrations/bling/operacaoRemotaContract';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';

import {
  createExclusaoDeClienteHandler,
  type ClienteParaExclusao,
  type EventoDeAuditoria,
  type ExclusaoDeClienteDependencies,
} from './handler';

/**
 * Exclusão de contato, contra portas falsas. O que se prova aqui é a ordem:
 * autorização → carga por id + organização → dependências → Bling com
 * confirmação → exclusão local conferida.
 *
 * O "banco" falso guarda clientes por organização, e o repositório falso
 * respeita o escopo como o real (`eq('organizacao_id', …)` em toda consulta):
 * é assim que o caso de outra organização é exercitado de verdade.
 */

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const ATOR = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const CLIENTE = '33333333-3333-4333-8333-333333333333';
const CLIENTE_DE_B = '44444444-4444-4444-8444-444444444444';

const escopoDe = (organizationId: string) =>
  ({ organizationId, actorId: ATOR, role: 'admin' }) as unknown as VerifiedOrganizationScope;

type LinhaDeCliente = ClienteParaExclusao & { readonly organizacaoId: string };

function montar(opcoes: {
  clientes?: LinhaDeCliente[];
  exclusao?: ExclusaoRemota | (() => Promise<ExclusaoRemota>);
  leitura?: LeituraRemota<ContatoRemoto>;
  escopo?: VerifiedOrganizationScope;
  negar?: number;
  excluirLocal?: (id: string) => Promise<number>;
  auditarFalha?: boolean;
} = {}) {
  const linhas = new Map((opcoes.clientes ?? []).map((c) => [c.id, c]));
  const excluirContato = vi.fn(async () => {
    const e = opcoes.exclusao ?? { _tag: 'ExclusaoAceita' as const };
    return typeof e === 'function' ? e() : e;
  });
  const consultarContato = vi.fn(async () => opcoes.leitura ?? ({ _tag: 'RemotoAusente' } as const));
  const eventos: EventoDeAuditoria[] = [];
  const excluir = vi.fn(async (scope: VerifiedOrganizationScope, id: string) => {
    if (opcoes.excluirLocal) return opcoes.excluirLocal(id);
    const linha = linhas.get(id);
    if (!linha || linha.organizacaoId !== scope.organizationId) return 0;
    linhas.delete(id);
    return 1;
  });

  const deps: ExclusaoDeClienteDependencies = {
    autorizar: async () =>
      opcoes.negar
        ? { _tag: 'Negado', response: NextResponse.json({ success: false }, { status: opcoes.negar }) }
        : { _tag: 'Autorizado', scope: opcoes.escopo ?? escopoDe(ORG_A) },
    store: {
      carregarParaExclusao: vi.fn(async (scope: VerifiedOrganizationScope, id: string) => {
        const linha = linhas.get(id);
        if (!linha || linha.organizacaoId !== scope.organizationId) return null;
        return { id: linha.id, blingId: linha.blingId, possuiHistorico: linha.possuiHistorico };
      }),
      excluir,
    },
    bling: () => ({ excluirContato, consultarContato }),
    auditar: vi.fn(async (_scope: VerifiedOrganizationScope, evento: EventoDeAuditoria) => {
      if (opcoes.auditarFalha) throw new Error('auditoria fora do ar');
      eventos.push(evento);
    }),
    correlationId: () => 'corr_teste',
  };

  const handler = createExclusaoDeClienteHandler(deps);
  const chamar = (corpo: unknown) =>
    handler(new Request('https://orbita.test/api/clientes/delete', { method: 'POST', body: JSON.stringify(corpo) }));

  return { chamar, linhas, excluirContato, consultarContato, excluir, eventos, deps };
}

const semHistorico = (blingId: string | null, organizacaoId = ORG_A, id = CLIENTE): LinhaDeCliente =>
  ({ id, organizacaoId, blingId, possuiHistorico: false });

async function corpo(resposta: Response) {
  return (await resposta.json()) as Record<string, unknown>;
}

describe('POST /api/clientes/delete — exclusão segura de contato', () => {
  it('admin exclui contato só do ORBITA: nada vai ao Bling', async () => {
    const t = montar({ clientes: [semHistorico(null)] });

    const resposta = await t.chamar({ id: CLIENTE });

    expect(resposta.status).toBe(200);
    expect(await corpo(resposta)).toEqual({ resultado: 'Deleted', removidoDoBling: false });
    expect(t.excluirContato).not.toHaveBeenCalled();
    expect(t.linhas.has(CLIENTE)).toBe(false);
  });

  it('contato do Bling é excluído com o bling_id CARREGADO do banco', async () => {
    const t = montar({ clientes: [semHistorico('5550001')] });

    const resposta = await t.chamar({ id: CLIENTE });

    expect(resposta.status).toBe(200);
    expect(await corpo(resposta)).toEqual({ resultado: 'Deleted', removidoDoBling: true });
    expect(t.excluirContato).toHaveBeenCalledWith('5550001');
  });

  it('bling_id adulterado no corpo não tem autoridade nenhuma', async () => {
    const t = montar({ clientes: [semHistorico('5550001')] });

    await t.chamar({ id: CLIENTE, bling_id: '999999', organizacao_id: ORG_B, user_id: ATOR });

    expect(t.excluirContato).toHaveBeenCalledTimes(1);
    expect(t.excluirContato).toHaveBeenCalledWith('5550001');
    expect(t.excluirContato).not.toHaveBeenCalledWith('999999');
  });

  it('sem capability a resposta da autorização passa adiante e nada é tocado', async () => {
    const t = montar({ clientes: [semHistorico('5550001')], negar: 403 });

    expect((await t.chamar({ id: CLIENTE })).status).toBe(403);
    expect(t.deps.store.carregarParaExclusao).not.toHaveBeenCalled();
    expect(t.excluirContato).not.toHaveBeenCalled();
  });

  it('cliente de outra organização: 404, e nada é tocado lá nem no Bling', async () => {
    const t = montar({ clientes: [semHistorico('7770001', ORG_B, CLIENTE_DE_B)] });

    const resposta = await t.chamar({ id: CLIENTE_DE_B });

    expect(resposta.status).toBe(404);
    expect(await corpo(resposta)).toEqual({ resultado: 'NotFound' });
    expect(t.excluirContato).not.toHaveBeenCalled();
    expect(t.excluir).not.toHaveBeenCalled();
    expect(t.linhas.has(CLIENTE_DE_B)).toBe(true);
  });

  it('inexistente e alheio respondem exatamente igual', async () => {
    const t = montar({ clientes: [semHistorico('7770001', ORG_B, CLIENTE_DE_B)] });
    const alheio = await t.chamar({ id: CLIENTE_DE_B });
    const inexistente = await t.chamar({ id: '55555555-5555-4555-8555-555555555555' });
    expect([alheio.status, await corpo(alheio)]).toEqual([inexistente.status, await corpo(inexistente)]);
  });

  it('com histórico (pedido, LGPD, retenção ou fornecedor): Blocked, sem Bling e sem exclusão local', async () => {
    const t = montar({ clientes: [{ ...semHistorico('5550001'), possuiHistorico: true }] });

    const resposta = await t.chamar({ id: CLIENTE });

    expect(resposta.status).toBe(409);
    expect(await corpo(resposta)).toEqual({ resultado: 'Blocked', motivo: 'possui_historico' });
    expect(t.excluirContato).not.toHaveBeenCalled();
    expect(t.excluir).not.toHaveBeenCalled();
  });

  it('recusa definitiva do Bling: o local permanece', async () => {
    const t = montar({ clientes: [semHistorico('5550001')], exclusao: { _tag: 'RemotoRecusou', status: 400 } });

    const resposta = await t.chamar({ id: CLIENTE });

    expect(resposta.status).toBe(502);
    expect(await corpo(resposta)).toEqual({ resultado: 'ProviderRefused', motivo: 'recusado_pelo_bling' });
    expect(t.excluir).not.toHaveBeenCalled();
    expect(t.linhas.has(CLIENTE)).toBe(true);
  });

  it('429 esgotado: não processado, o local permanece', async () => {
    const t = montar({ clientes: [semHistorico('5550001')], exclusao: { _tag: 'RemotoLimitado' } });
    const resposta = await t.chamar({ id: CLIENTE });
    expect(await corpo(resposta)).toEqual({ resultado: 'ProviderRefused', motivo: 'limite_de_requisicoes' });
    expect(t.excluir).not.toHaveBeenCalled();
  });

  it('ACK perdido + leitura 404: conclui localmente', async () => {
    const t = montar({
      clientes: [semHistorico('5550001')],
      exclusao: { _tag: 'RemotoIndeterminado', causa: 'prazo_esgotado' },
      leitura: { _tag: 'RemotoAusente' },
    });

    const resposta = await t.chamar({ id: CLIENTE });

    expect(await corpo(resposta)).toEqual({ resultado: 'Deleted', removidoDoBling: true });
    expect(t.excluirContato).toHaveBeenCalledTimes(1);
  });

  it('timeout + leitura 200: o contato continua no Bling e o local permanece', async () => {
    const t = montar({
      clientes: [semHistorico('5550001')],
      exclusao: { _tag: 'RemotoIndeterminado', causa: 'prazo_esgotado' },
      leitura: { _tag: 'RemotoPresente', valor: { id: '5550001' } },
    });

    const resposta = await t.chamar({ id: CLIENTE });

    expect(await corpo(resposta)).toEqual({ resultado: 'ProviderRefused', motivo: 'exclusao_nao_confirmada' });
    expect(t.excluir).not.toHaveBeenCalled();
  });

  it('resultado ambíguo: ReconcileRequired, local intacto, auditoria sem PII', async () => {
    const t = montar({
      clientes: [semHistorico('5550001')],
      exclusao: { _tag: 'RemotoIndeterminado', causa: 'erro_do_servidor' },
      leitura: { _tag: 'RemotoIndeterminado', causa: 'falha_de_rede' },
    });

    const resposta = await t.chamar({ id: CLIENTE });

    expect(resposta.status).toBe(503);
    expect(await corpo(resposta)).toEqual({ resultado: 'ReconcileRequired', motivo: 'estado_remoto_indeterminado' });
    expect(t.excluir).not.toHaveBeenCalled();
    expect(t.linhas.has(CLIENTE)).toBe(true);
    expect(t.eventos).toEqual([
      expect.objectContaining({ acao: 'customer.contact_reconcile_required', recursoId: CLIENTE }),
    ]);
  });

  it('exclusão local de zero linhas não é sucesso', async () => {
    const t = montar({ clientes: [semHistorico(null)], excluirLocal: async () => 0 });

    const resposta = await t.chamar({ id: CLIENTE });

    expect(resposta.status).toBe(404);
    expect(await corpo(resposta)).toEqual({ resultado: 'NotFound' });
    expect(t.eventos).toEqual([]);
  });

  it('pedido criado depois da checagem faz o banco recusar: contato local-only fica Blocked', async () => {
    const t = montar({
      clientes: [semHistorico(null)],
      excluirLocal: async () => { throw new Error('violates foreign key constraint'); },
    });
    const resposta = await t.chamar({ id: CLIENTE });
    expect(await corpo(resposta)).toEqual({ resultado: 'Blocked', motivo: 'possui_historico' });
  });

  it('removido do Bling mas o banco falhou: pede reconciliação, não "falhou"', async () => {
    const t = montar({
      clientes: [semHistorico('5550001')],
      excluirLocal: async () => { throw new Error('connection reset'); },
    });
    const resposta = await t.chamar({ id: CLIENTE });
    expect(resposta.status).toBe(503);
    expect(await corpo(resposta)).toEqual({ resultado: 'ReconcileRequired', motivo: 'conclusao_local_pendente' });
  });

  it('repetição depois do sucesso é segura: NotFound, sem segundo DELETE no Bling', async () => {
    const t = montar({ clientes: [semHistorico('5550001')] });

    await t.chamar({ id: CLIENTE });
    const segunda = await t.chamar({ id: CLIENTE });

    expect(await corpo(segunda)).toEqual({ resultado: 'NotFound' });
    expect(t.excluirContato).toHaveBeenCalledTimes(1);
  });

  it('repetição depois de remover no Bling e falhar no banco conclui pela leitura', async () => {
    let tentativas = 0;
    const t = montar({
      clientes: [semHistorico('5550001')],
      exclusao: () => Promise.resolve(tentativas === 0 ? { _tag: 'ExclusaoAceita' as const } : { _tag: 'RemotoAusente' as const }),
      leitura: { _tag: 'RemotoAusente' },
      excluirLocal: async () => {
        tentativas += 1;
        if (tentativas === 1) throw new Error('connection reset');
        return 1;
      },
    });

    const primeira = await t.chamar({ id: CLIENTE });
    const segunda = await t.chamar({ id: CLIENTE });

    expect((await corpo(primeira)).resultado).toBe('ReconcileRequired');
    expect(await corpo(segunda)).toEqual({ resultado: 'Deleted', removidoDoBling: true });
    // O 404 do segundo DELETE foi confirmado por leitura antes de concluir.
    expect(t.consultarContato).toHaveBeenCalledTimes(1);
  });

  it('auditoria que falha depois do efeito não transforma sucesso em falha', async () => {
    const t = montar({ clientes: [semHistorico('5550001')], auditarFalha: true });
    const resposta = await t.chamar({ id: CLIENTE });
    expect(await corpo(resposta)).toEqual({ resultado: 'Deleted', removidoDoBling: true });
  });

  it('o evento de exclusão leva só ids técnicos', async () => {
    const t = montar({ clientes: [semHistorico('5550001')] });
    await t.chamar({ id: CLIENTE });
    expect(t.eventos).toEqual([{
      acao: 'customer.contact_deleted',
      recurso: 'cliente',
      recursoId: CLIENTE,
      correlationId: 'corr_teste',
      metadata: { removido_do_bling: true, bling_id: '5550001' },
    }]);
  });

  it.each([{}, { id: 'c1' }, { bling_id: '5550001' }, null])('corpo sem id válido (%j) é InvalidRequest', async (entrada) => {
    const t = montar({ clientes: [semHistorico('5550001')] });
    const resposta = await t.chamar(entrada);
    expect(resposta.status).toBe(400);
    expect(t.excluirContato).not.toHaveBeenCalled();
  });
});
