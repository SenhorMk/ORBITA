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
 * autorização → carga por id + organização → dependências → leitura do contato
 * no Bling → exclusão confirmada → nova classificação → exclusão local
 * conferida.
 *
 * O "banco" falso guarda clientes por organização e o repositório falso
 * respeita o escopo como o real. O Bling falso registra, **em ordem**, cada
 * leitura e cada exclusão — é assim que "nenhuma repetição começa por outro
 * DELETE" é provado por contagem e por sequência, não por suposição.
 */

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const ATOR = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const CLIENTE = '33333333-3333-4333-8333-333333333333';
const CLIENTE_DE_B = '44444444-4444-4444-8444-444444444444';

const escopoDe = (organizationId: string) =>
  ({ organizationId, actorId: ATOR, role: 'admin' }) as unknown as VerifiedOrganizationScope;

type LinhaDeCliente = ClienteParaExclusao & { readonly organizacaoId: string };

const PRESENTE: LeituraRemota<ContatoRemoto> = { _tag: 'RemotoPresente', valor: { id: '5550001' } };
const AUSENTE: LeituraRemota<ContatoRemoto> = { _tag: 'RemotoAusente' };
const SEM_PROVA: LeituraRemota<ContatoRemoto> = { _tag: 'RemotoIndeterminado', causa: 'falha_de_rede' };

function montar(opcoes: {
  clientes?: LinhaDeCliente[];
  /** Respostas da leitura, em ordem. Esgotada a fila, a última se repete. */
  leituras?: LeituraRemota<ContatoRemoto>[];
  /** Respostas da exclusão, em ordem. Esgotada a fila, a última se repete. */
  exclusoes?: ExclusaoRemota[];
  /** Efeito colateral durante o DELETE remoto — ex.: um pedido que nasce. */
  duranteAExclusaoRemota?: (linhas: Map<string, LinhaDeCliente>) => void;
  escopo?: VerifiedOrganizationScope;
  negar?: number;
  excluirLocal?: (id: string, linhas: Map<string, LinhaDeCliente>) => Promise<number>;
  auditarFalha?: boolean;
} = {}) {
  const linhas = new Map((opcoes.clientes ?? []).map((c) => [c.id, c]));
  const remoto: string[] = [];
  const leituras = [...(opcoes.leituras ?? [PRESENTE, AUSENTE])];
  const exclusoes = [...(opcoes.exclusoes ?? [{ _tag: 'ExclusaoAceita' as const }])];
  const proxima = <T,>(fila: T[]) => (fila.length > 1 ? fila.shift()! : fila[0]!);

  const consultarContato = vi.fn(async (id: string) => {
    remoto.push(`GET ${id}`);
    return proxima(leituras);
  });
  const excluirContato = vi.fn(async (id: string) => {
    remoto.push(`DELETE ${id}`);
    opcoes.duranteAExclusaoRemota?.(linhas);
    return proxima(exclusoes);
  });
  const eventos: EventoDeAuditoria[] = [];
  const excluir = vi.fn(async (scope: VerifiedOrganizationScope, id: string) => {
    if (opcoes.excluirLocal) return opcoes.excluirLocal(id, linhas);
    const linha = linhas.get(id);
    if (!linha || linha.organizacaoId !== scope.organizationId) return 0;
    // O banco real recusa por FK/gatilho quem tem pedido.
    if (linha.possuiHistorico) throw new Error('violates foreign key constraint "fk_pedido_cliente"');
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

  return { chamar, linhas, remoto, excluirContato, consultarContato, excluir, eventos, deps };
}

const semHistorico = (blingId: string | null, organizacaoId = ORG_A, id = CLIENTE): LinhaDeCliente =>
  ({ id, organizacaoId, blingId, possuiHistorico: false });

/** Um pedido nasce para o cliente: agora ele tem histórico. */
function pedidoNasce(linhas: Map<string, LinhaDeCliente>) {
  const linha = linhas.get(CLIENTE)!;
  linhas.set(CLIENTE, { ...linha, possuiHistorico: true });
}

async function corpo(resposta: Response) {
  return (await resposta.json()) as Record<string, unknown>;
}

describe('POST /api/clientes/delete — exclusão segura de contato', () => {
  it('admin exclui contato só do ORBITA: nada vai ao Bling', async () => {
    const t = montar({ clientes: [semHistorico(null)] });

    const resposta = await t.chamar({ id: CLIENTE });

    expect(resposta.status).toBe(200);
    expect(await corpo(resposta)).toEqual({ resultado: 'Deleted', removidoDoBling: false });
    expect(t.remoto).toEqual([]);
    expect(t.linhas.has(CLIENTE)).toBe(false);
  });

  it('contato do Bling: lê primeiro, depois exclui, com o bling_id CARREGADO do banco', async () => {
    const t = montar({ clientes: [semHistorico('5550001')] });

    const resposta = await t.chamar({ id: CLIENTE });

    expect(await corpo(resposta)).toEqual({ resultado: 'Deleted', removidoDoBling: true });
    expect(t.remoto).toEqual(['GET 5550001', 'DELETE 5550001']);
  });

  it('bling_id adulterado no corpo não tem autoridade nenhuma', async () => {
    const t = montar({ clientes: [semHistorico('5550001')] });

    await t.chamar({ id: CLIENTE, bling_id: '999999', organizacao_id: ORG_B, user_id: ATOR });

    expect(t.remoto).toEqual(['GET 5550001', 'DELETE 5550001']);
    expect(t.remoto.join(' ')).not.toContain('999999');
  });

  it('sem capability a resposta da autorização passa adiante e nada é tocado', async () => {
    const t = montar({ clientes: [semHistorico('5550001')], negar: 403 });

    expect((await t.chamar({ id: CLIENTE })).status).toBe(403);
    expect(t.deps.store.carregarParaExclusao).not.toHaveBeenCalled();
    expect(t.remoto).toEqual([]);
  });

  it('cliente de outra organização: 404, e nada é tocado lá nem no Bling', async () => {
    const t = montar({ clientes: [semHistorico('7770001', ORG_B, CLIENTE_DE_B)] });

    const resposta = await t.chamar({ id: CLIENTE_DE_B });

    expect(resposta.status).toBe(404);
    expect(await corpo(resposta)).toEqual({ resultado: 'NotFound' });
    expect(t.remoto).toEqual([]);
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
    expect(t.remoto).toEqual([]);
    expect(t.excluir).not.toHaveBeenCalled();
  });

  it('recusa definitiva do Bling: o local permanece', async () => {
    const t = montar({ clientes: [semHistorico('5550001')], exclusoes: [{ _tag: 'RemotoRecusou', status: 400 }] });

    const resposta = await t.chamar({ id: CLIENTE });

    expect(resposta.status).toBe(502);
    expect(await corpo(resposta)).toEqual({ resultado: 'ProviderRefused', motivo: 'recusado_pelo_bling' });
    expect(t.excluir).not.toHaveBeenCalled();
    expect(t.linhas.has(CLIENTE)).toBe(true);
  });

  it('429 esgotado: não processado, o local permanece', async () => {
    const t = montar({ clientes: [semHistorico('5550001')], exclusoes: [{ _tag: 'RemotoLimitado' }] });
    const resposta = await t.chamar({ id: CLIENTE });
    expect(await corpo(resposta)).toEqual({ resultado: 'ProviderRefused', motivo: 'limite_de_requisicoes' });
    expect(t.excluir).not.toHaveBeenCalled();
  });

  it('ACK perdido + leitura 404: conclui localmente', async () => {
    const t = montar({
      clientes: [semHistorico('5550001')],
      leituras: [PRESENTE, AUSENTE],
      exclusoes: [{ _tag: 'RemotoIndeterminado', causa: 'prazo_esgotado' }],
    });

    const resposta = await t.chamar({ id: CLIENTE });

    expect(await corpo(resposta)).toEqual({ resultado: 'Deleted', removidoDoBling: true });
    expect(t.remoto).toEqual(['GET 5550001', 'DELETE 5550001', 'GET 5550001']);
  });

  it('timeout + leitura 200: o contato continua no Bling e o local permanece', async () => {
    const t = montar({
      clientes: [semHistorico('5550001')],
      leituras: [PRESENTE, PRESENTE],
      exclusoes: [{ _tag: 'RemotoIndeterminado', causa: 'prazo_esgotado' }],
    });

    const resposta = await t.chamar({ id: CLIENTE });

    expect(await corpo(resposta)).toEqual({ resultado: 'ProviderRefused', motivo: 'exclusao_nao_confirmada' });
    expect(t.excluir).not.toHaveBeenCalled();
  });

  it('resultado ambíguo: ReconcileRequired, local intacto, auditoria sem PII', async () => {
    const t = montar({
      clientes: [semHistorico('5550001')],
      leituras: [PRESENTE, SEM_PROVA],
      exclusoes: [{ _tag: 'RemotoIndeterminado', causa: 'erro_do_servidor' }],
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

  describe('a leitura vem antes de qualquer DELETE', () => {
    it('remoto já ausente na leitura: nenhum DELETE sai, e a exclusão local conclui', async () => {
      const t = montar({ clientes: [semHistorico('5550001')], leituras: [AUSENTE] });

      const resposta = await t.chamar({ id: CLIENTE });

      expect(await corpo(resposta)).toEqual({ resultado: 'Deleted', removidoDoBling: true });
      expect(t.remoto).toEqual(['GET 5550001']);
      expect(t.excluirContato).not.toHaveBeenCalled();
    });

    it('leitura sem prova: ReconcileRequired sem DELETE', async () => {
      const t = montar({ clientes: [semHistorico('5550001')], leituras: [SEM_PROVA] });

      expect(await corpo(await t.chamar({ id: CLIENTE }))).toEqual({
        resultado: 'ReconcileRequired', motivo: 'estado_remoto_indeterminado',
      });
      expect(t.remoto).toEqual(['GET 5550001']);
    });

    it.each<[LeituraRemota<ContatoRemoto>, string]>([
      [{ _tag: 'RemotoRecusou', status: 403 }, 'recusado_pelo_bling'],
      [{ _tag: 'RemotoLimitado' }, 'limite_de_requisicoes'],
    ])('leitura %j: ProviderRefused sem inventar ausência e sem DELETE', async (leitura, motivo) => {
      const t = montar({ clientes: [semHistorico('5550001')], leituras: [leitura] });

      expect(await corpo(await t.chamar({ id: CLIENTE }))).toEqual({ resultado: 'ProviderRefused', motivo });
      expect(t.remoto).toEqual(['GET 5550001']);
      expect(t.excluir).not.toHaveBeenCalled();
    });

    it('retry depois de ReconcileRequired começa pela leitura — nunca por outro DELETE', async () => {
      // 1ª tentativa: GET 200 → DELETE sem resposta → GET sem prova.
      // 2ª tentativa: GET 404 (o DELETE da 1ª tinha pegado).
      const t = montar({
        clientes: [semHistorico('5550001')],
        leituras: [PRESENTE, SEM_PROVA, AUSENTE],
        exclusoes: [{ _tag: 'RemotoIndeterminado', causa: 'prazo_esgotado' }],
      });

      const primeira = await t.chamar({ id: CLIENTE });
      const doisPrimeiros = t.remoto.length;
      const segunda = await t.chamar({ id: CLIENTE });

      expect((await corpo(primeira)).resultado).toBe('ReconcileRequired');
      expect(await corpo(segunda)).toEqual({ resultado: 'Deleted', removidoDoBling: true });
      expect(t.remoto).toEqual(['GET 5550001', 'DELETE 5550001', 'GET 5550001', 'GET 5550001']);
      // A primeira chamada remota da segunda tentativa é uma leitura.
      expect(t.remoto[doisPrimeiros]).toBe('GET 5550001');
      expect(t.excluirContato).toHaveBeenCalledTimes(1);
    });

    it('retry depois de remover no Bling e falhar no banco: lê 404 e conclui sem DELETE', async () => {
      let tentativasLocais = 0;
      const t = montar({
        clientes: [semHistorico('5550001')],
        leituras: [PRESENTE, AUSENTE],
        excluirLocal: async (id, linhas) => {
          tentativasLocais += 1;
          if (tentativasLocais === 1) throw new Error('connection reset');
          linhas.delete(id);
          return 1;
        },
      });

      const primeira = await t.chamar({ id: CLIENTE });
      const segunda = await t.chamar({ id: CLIENTE });

      expect(await corpo(primeira)).toEqual({ resultado: 'ReconcileRequired', motivo: 'conclusao_local_pendente' });
      expect(await corpo(segunda)).toEqual({ resultado: 'Deleted', removidoDoBling: true });
      expect(t.remoto).toEqual(['GET 5550001', 'DELETE 5550001', 'GET 5550001']);
    });
  });

  describe('histórico que surge depois da exclusão remota', () => {
    it('pré-checagem limpa → DELETE confirmado → pedido nasce → cliente preservado, resposta honesta', async () => {
      const t = montar({ clientes: [semHistorico('5550001')], duranteAExclusaoRemota: pedidoNasce });

      const resposta = await t.chamar({ id: CLIENTE });

      expect(resposta.status).toBe(409);
      expect(await corpo(resposta)).toEqual({
        resultado: 'Blocked', motivo: 'preservado_por_historico_apos_remocao_no_bling',
      });
      // Nada de forçar: a linha local fica, e o DELETE local nem é tentado.
      expect(t.linhas.has(CLIENTE)).toBe(true);
      expect(t.excluir).not.toHaveBeenCalled();
      expect(t.eventos).toEqual([{
        acao: 'customer.contact_preserved_after_remote_removal',
        recurso: 'cliente',
        recursoId: CLIENTE,
        correlationId: 'corr_teste',
        metadata: { bling_id: '5550001', estado_remoto: 'ausente', cliente_local: 'preservado_por_historico' },
      }]);
    });

    it('nova tentativa: lê 404, reencontra o histórico e dá o mesmo desfecho — sem DELETE remoto', async () => {
      const t = montar({
        clientes: [semHistorico('5550001')],
        leituras: [PRESENTE, AUSENTE],
        duranteAExclusaoRemota: pedidoNasce,
      });

      await t.chamar({ id: CLIENTE });
      const segunda = await t.chamar({ id: CLIENTE });

      expect(await corpo(segunda)).toEqual({
        resultado: 'Blocked', motivo: 'possui_historico',
      });
      expect(t.excluirContato).toHaveBeenCalledTimes(1);
      expect(t.linhas.has(CLIENTE)).toBe(true);
    });

    it('pedido que nasce entre a segunda classificação e o DELETE local: o banco recusa e a resposta é a de preservação', async () => {
      const t = montar({
        clientes: [semHistorico('5550001')],
        excluirLocal: async (_id, linhas) => {
          pedidoNasce(linhas);
          throw new Error('violates foreign key constraint "fk_pedido_cliente"');
        },
      });

      expect(await corpo(await t.chamar({ id: CLIENTE }))).toEqual({
        resultado: 'Blocked', motivo: 'preservado_por_historico_apos_remocao_no_bling',
      });
      expect(t.linhas.has(CLIENTE)).toBe(true);
    });

    it('contato só do ORBITA que ganha pedido no meio: Blocked comum (nada foi ao Bling)', async () => {
      const t = montar({
        clientes: [semHistorico(null)],
        excluirLocal: async (_id, linhas) => {
          pedidoNasce(linhas);
          throw new Error('violates foreign key constraint "fk_pedido_cliente"');
        },
      });

      expect(await corpo(await t.chamar({ id: CLIENTE }))).toEqual({ resultado: 'Blocked', motivo: 'possui_historico' });
      expect(t.remoto).toEqual([]);
    });
  });

  it('exclusão local de zero linhas não é sucesso', async () => {
    const t = montar({ clientes: [semHistorico(null)], excluirLocal: async () => 0 });

    const resposta = await t.chamar({ id: CLIENTE });

    expect(resposta.status).toBe(404);
    expect(await corpo(resposta)).toEqual({ resultado: 'NotFound' });
    expect(t.eventos).toEqual([]);
  });

  it('repetição depois do sucesso é segura: NotFound, sem segundo DELETE no Bling', async () => {
    const t = montar({ clientes: [semHistorico('5550001')] });

    await t.chamar({ id: CLIENTE });
    const segunda = await t.chamar({ id: CLIENTE });

    expect(await corpo(segunda)).toEqual({ resultado: 'NotFound' });
    expect(t.excluirContato).toHaveBeenCalledTimes(1);
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
      metadata: { removido_do_bling: true, bling_id: '5550001', evidencia_remota: 'exclusao' },
    }]);
  });

  it.each([{}, { id: 'c1' }, { bling_id: '5550001' }, null])('corpo sem id válido (%j) é InvalidRequest', async (entrada) => {
    const t = montar({ clientes: [semHistorico('5550001')] });
    const resposta = await t.chamar(entrada);
    expect(resposta.status).toBe(400);
    expect(t.remoto).toEqual([]);
  });
});
