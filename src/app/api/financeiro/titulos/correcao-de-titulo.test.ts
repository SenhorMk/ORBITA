import { NextResponse } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

import type { ExclusaoRemota, LeituraRemota } from '@/lib/integrations/bling/operacaoRemotaContract';
import type { CodigoDaSituacaoDaConta } from '@/lib/integrations/bling/situacaoDaContaBling';
import { movimentacaoContaComoAtiva } from '@/lib/metricas/movimentacaoAtiva';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import type { ContaPagarRemota } from '@/services/blingPort';

import {
  createCancelamentoDeDespesaHandler,
  createExclusaoDeLancamentoHandler,
  type CorrecaoDeTituloDependencies,
  type EventoDeAuditoriaFinanceira,
  type TituloParaCorrecao,
} from './correcaoDeTitulo';

/**
 * Correção de despesa contra portas falsas. O "banco" guarda títulos por
 * organização e o repositório falso aplica as mesmas condições estruturais do
 * real — organização, `tipo`, `bling_id`, `pedido_id` e situação ativa.
 */

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const ATOR = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const TITULO = '66666666-6666-4666-8666-666666666666';

/** Uma linha do banco falso: mutável, para simular mudança concorrente. */
type Linha = { -readonly [K in keyof TituloParaCorrecao]: TituloParaCorrecao[K] } & { organizacaoId: string };

const escopo = { organizationId: ORG_A, actorId: ATOR, role: 'owner' } as unknown as VerifiedOrganizationScope;

function montar(opcoes: {
  titulos: Linha[];
  leituras?: LeituraRemota<ContaPagarRemota>[];
  exclusao?: ExclusaoRemota;
  negar?: number;
  marcarFalha?: boolean;
  /** Mudança concorrente aplicada entre a classificação e o DELETE local. */
  antesDoDelete?: (linha: Linha) => void;
}) {
  const linhas = new Map(opcoes.titulos.map((t) => [t.id, { ...t }]));
  const leituras = [...(opcoes.leituras ?? [])];
  const consultarContaPagar = vi.fn(async () => leituras.shift() ?? { _tag: 'RemotoAusente' as const });
  const excluirContaPagar = vi.fn(async () => opcoes.exclusao ?? { _tag: 'ExclusaoAceita' as const });
  const eventos: EventoDeAuditoriaFinanceira[] = [];

  const doEscopo = (scope: VerifiedOrganizationScope, id: string) => {
    const linha = linhas.get(id);
    return linha && linha.organizacaoId === scope.organizationId ? linha : undefined;
  };

  const deps: CorrecaoDeTituloDependencies = {
    autorizar: async () =>
      opcoes.negar
        ? { _tag: 'Negado', response: NextResponse.json({ success: false }, { status: opcoes.negar }) }
        : { _tag: 'Autorizado', scope: escopo },
    store: {
      carregarTituloParaCorrecao: vi.fn(async (scope, id) => {
        const l = doEscopo(scope, id);
        return l ? { id: l.id, tipo: l.tipo, situacao: l.situacao, blingId: l.blingId, pedidoId: l.pedidoId } : null;
      }),
      excluirLancamentoInterno: vi.fn(async (scope, id) => {
        const l = doEscopo(scope, id);
        if (l) opcoes.antesDoDelete?.(l);
        // As mesmas condições do `WHERE` real, inclusive a situação ativa.
        if (!l || l.tipo !== 'pagar' || l.blingId !== null || l.pedidoId !== null) return 0;
        if (!movimentacaoContaComoAtiva(l.situacao)) return 0;
        linhas.delete(id);
        return 1;
      }),
      marcarDespesaCancelada: vi.fn(async (scope, id) => {
        if (opcoes.marcarFalha) throw new Error('connection reset');
        const l = doEscopo(scope, id);
        if (!l || l.tipo !== 'pagar' || l.blingId === null || !movimentacaoContaComoAtiva(l.situacao)) return 0;
        l.situacao = 'cancelado';
        return 1;
      }),
    },
    bling: () => ({ consultarContaPagar, excluirContaPagar }),
    auditar: vi.fn(async (_s, evento: EventoDeAuditoriaFinanceira) => { eventos.push(evento); }),
    correlationId: () => 'corr_teste',
  };

  const req = () => new Request('https://orbita.test/x', { method: 'POST' });
  return {
    excluir: (id = TITULO) => createExclusaoDeLancamentoHandler(deps)(req(), id),
    cancelar: (id = TITULO) => createCancelamentoDeDespesaHandler(deps)(req(), id),
    linhas, consultarContaPagar, excluirContaPagar, eventos, deps,
  };
}

const interna = (situacao: string, extra: Partial<Linha> = {}): Linha => ({
  id: TITULO, organizacaoId: ORG_A, tipo: 'pagar', situacao, blingId: null, pedidoId: null, ...extra,
});
const doBling = (situacao = 'aberto', extra: Partial<Linha> = {}): Linha =>
  interna(situacao, { blingId: '8800001', ...extra });
const remota = (situacao: CodigoDaSituacaoDaConta): LeituraRemota<ContaPagarRemota> =>
  ({ _tag: 'RemotoPresente', valor: { id: '8800001', situacao } });

async function corpo(resposta: Response) {
  return (await resposta.json()) as Record<string, unknown>;
}

describe('POST /api/financeiro/titulos/{id}/exclusao — despesa interna', () => {
  it.each(['aberto', 'pago'])('interna %s é removida definitivamente', async (situacao) => {
    const t = montar({ titulos: [interna(situacao)] });

    const resposta = await t.excluir();

    expect(resposta.status).toBe(200);
    expect(await corpo(resposta)).toEqual({ resultado: 'Deleted', removidoDoBling: false });
    expect(t.linhas.has(TITULO)).toBe(false);
    expect(t.eventos).toEqual([expect.objectContaining({
      acao: 'finance.entry_deleted', recursoId: TITULO, metadata: { situacao_anterior: situacao, origem: 'interno' },
    })]);
  });

  it('com pedido: Blocked, nada removido', async () => {
    const t = montar({ titulos: [interna('aberto', { pedidoId: '77777777-7777-4777-8777-777777777777' })] });
    const resposta = await t.excluir();
    expect(resposta.status).toBe(409);
    expect(await corpo(resposta)).toEqual({ resultado: 'Blocked', motivo: 'vinculado_a_pedido' });
    expect(t.linhas.has(TITULO)).toBe(true);
  });

  it('despesa do Bling não é apagada localmente', async () => {
    const t = montar({ titulos: [doBling()] });
    expect(await corpo(await t.excluir())).toEqual({ resultado: 'Blocked', motivo: 'despesa_do_bling' });
    expect(t.linhas.has(TITULO)).toBe(true);
  });

  it('conta a receber não é despesa', async () => {
    const t = montar({ titulos: [interna('aberto', { tipo: 'receber' })] });
    expect(await corpo(await t.excluir())).toEqual({ resultado: 'Blocked', motivo: 'nao_e_despesa' });
  });

  it('outra organização: 404 e nada é tocado', async () => {
    const t = montar({ titulos: [interna('aberto', { organizacaoId: ORG_B })] });
    const resposta = await t.excluir();
    expect(resposta.status).toBe(404);
    expect(t.linhas.has(TITULO)).toBe(true);
    expect(t.deps.store.excluirLancamentoInterno).not.toHaveBeenCalled();
  });

  it('repetir depois do sucesso: NotFound, sem segundo evento', async () => {
    const t = montar({ titulos: [interna('aberto')] });
    await t.excluir();
    expect(await corpo(await t.excluir())).toEqual({ resultado: 'NotFound' });
    expect(t.eventos).toHaveLength(1);
  });

  it('corrida: ativo na classificação, terminal antes do DELETE → não removido, AlreadyTerminal', async () => {
    const t = montar({
      titulos: [interna('aberto')],
      antesDoDelete: (linha) => { linha.situacao = 'cancelado'; },
    });

    const resposta = await t.excluir();

    expect(resposta.status).toBe(200);
    expect(await corpo(resposta)).toEqual({ resultado: 'AlreadyTerminal' });
    expect(t.linhas.get(TITULO)?.situacao).toBe('cancelado');
    expect(t.eventos).toEqual([]);
  });

  it('corrida: ganhou vínculo com pedido antes do DELETE → Blocked, não NotFound', async () => {
    const t = montar({
      titulos: [interna('aberto')],
      antesDoDelete: (linha) => { linha.pedidoId = '77777777-7777-4777-8777-777777777777'; },
    });

    expect(await corpo(await t.excluir())).toEqual({ resultado: 'Blocked', motivo: 'vinculado_a_pedido' });
    expect(t.linhas.has(TITULO)).toBe(true);
  });

  it('interna já terminal: AlreadyTerminal, sem tentar o DELETE', async () => {
    const t = montar({ titulos: [interna('cancelado')] });
    expect(await corpo(await t.excluir())).toEqual({ resultado: 'AlreadyTerminal' });
    expect(t.deps.store.excluirLancamentoInterno).not.toHaveBeenCalled();
  });

  it('sem capability: a negação passa adiante e nada é lido', async () => {
    const t = montar({ titulos: [interna('aberto')], negar: 403 });
    expect((await t.excluir()).status).toBe(403);
    expect(t.deps.store.carregarTituloParaCorrecao).not.toHaveBeenCalled();
  });

  it('id que não é UUID é InvalidRequest', async () => {
    const t = montar({ titulos: [interna('aberto')] });
    expect((await t.excluir('abc')).status).toBe(400);
  });
});

describe('POST /api/financeiro/titulos/{id}/cancelamento — despesa do Bling', () => {
  it('aberta no Bling + DELETE 204 → cancelado, e o título continua no histórico', async () => {
    const t = montar({ titulos: [doBling()], leituras: [remota(1)] });

    const resposta = await t.cancelar();

    expect(resposta.status).toBe(200);
    expect(await corpo(resposta)).toEqual({ resultado: 'Cancelled' });
    expect(t.excluirContaPagar).toHaveBeenCalledWith('8800001');
    expect(t.linhas.get(TITULO)?.situacao).toBe('cancelado');
    // Cancelada sai dos totais: a mesma regra única que o resumo e os gráficos usam.
    expect(movimentacaoContaComoAtiva(t.linhas.get(TITULO)!.situacao)).toBe(false);
    expect(t.eventos).toEqual([expect.objectContaining({
      acao: 'finance.expense_cancelled',
      metadata: { bling_id: '8800001', evidencia: 'exclusao_confirmada', situacao_anterior: 'aberto' },
    })]);
  });

  it('5 Cancelado no Bling converge sem novo DELETE', async () => {
    const t = montar({ titulos: [doBling()], leituras: [remota(5)] });
    expect(await corpo(await t.cancelar())).toEqual({ resultado: 'Cancelled' });
    expect(t.excluirContaPagar).not.toHaveBeenCalled();
    expect(t.linhas.get(TITULO)?.situacao).toBe('cancelado');
  });

  it('ausente no Bling (404) converge sem novo DELETE', async () => {
    const t = montar({ titulos: [doBling()], leituras: [{ _tag: 'RemotoAusente' }] });
    expect(await corpo(await t.cancelar())).toEqual({ resultado: 'Cancelled' });
    expect(t.excluirContaPagar).not.toHaveBeenCalled();
  });

  it('paga no Bling: Blocked, sem DELETE e sem estorno', async () => {
    const t = montar({ titulos: [doBling('aberto')], leituras: [remota(2)] });

    const resposta = await t.cancelar();

    expect(resposta.status).toBe(409);
    expect(await corpo(resposta)).toEqual({ resultado: 'Blocked', motivo: 'estorno_nao_suportado_com_seguranca' });
    expect(t.excluirContaPagar).not.toHaveBeenCalled();
    expect(t.linhas.get(TITULO)?.situacao).toBe('aberto');
  });

  it.each<CodigoDaSituacaoDaConta>([3, 4, 6, 7])('situação %i no Bling: Blocked, sem DELETE', async (codigo) => {
    const t = montar({ titulos: [doBling()], leituras: [remota(codigo)] });
    expect(await corpo(await t.cancelar())).toEqual({ resultado: 'Blocked', motivo: 'situacao_remota_impede_cancelamento' });
    expect(t.excluirContaPagar).not.toHaveBeenCalled();
  });

  it('a situação local não é autoridade: pago aqui, aberto lá → cancela', async () => {
    const t = montar({ titulos: [doBling('pago')], leituras: [remota(1)] });
    expect(await corpo(await t.cancelar())).toEqual({ resultado: 'Cancelled' });
  });

  it('timeout do DELETE + leitura 404 → Cancelled', async () => {
    const t = montar({
      titulos: [doBling()],
      leituras: [remota(1), { _tag: 'RemotoAusente' }],
      exclusao: { _tag: 'RemotoIndeterminado', causa: 'prazo_esgotado' },
    });
    expect(await corpo(await t.cancelar())).toEqual({ resultado: 'Cancelled' });
    expect(t.excluirContaPagar).toHaveBeenCalledTimes(1);
  });

  it('timeout do DELETE + leitura 200 → o local não muda', async () => {
    const t = montar({
      titulos: [doBling()],
      leituras: [remota(1), remota(1)],
      exclusao: { _tag: 'RemotoIndeterminado', causa: 'prazo_esgotado' },
    });
    expect(await corpo(await t.cancelar())).toEqual({ resultado: 'ProviderRefused', motivo: 'exclusao_nao_confirmada' });
    expect(t.linhas.get(TITULO)?.situacao).toBe('aberto');
  });

  it('DELETE e leitura ambíguos → ReconcileRequired, o local não muda, auditoria registrada', async () => {
    const t = montar({
      titulos: [doBling()],
      leituras: [remota(1), { _tag: 'RemotoIndeterminado', causa: 'falha_de_rede' }],
      exclusao: { _tag: 'RemotoIndeterminado', causa: 'erro_do_servidor' },
    });

    const resposta = await t.cancelar();

    expect(resposta.status).toBe(503);
    expect(await corpo(resposta)).toEqual({ resultado: 'ReconcileRequired', motivo: 'estado_remoto_indeterminado' });
    expect(t.linhas.get(TITULO)?.situacao).toBe('aberto');
    expect(t.deps.store.marcarDespesaCancelada).not.toHaveBeenCalled();
    expect(t.eventos).toEqual([expect.objectContaining({ acao: 'finance.remote_reconcile_required' })]);
  });

  it('leitura inicial ambígua → ReconcileRequired sem DELETE', async () => {
    const t = montar({ titulos: [doBling()], leituras: [{ _tag: 'RemotoIndeterminado', causa: 'prazo_esgotado' }] });
    expect((await corpo(await t.cancelar())).resultado).toBe('ReconcileRequired');
    expect(t.excluirContaPagar).not.toHaveBeenCalled();
  });

  it('recusa definitiva do DELETE → ProviderRefused, local intacto', async () => {
    const t = montar({ titulos: [doBling()], leituras: [remota(1)], exclusao: { _tag: 'RemotoRecusou', status: 400 } });
    expect(await corpo(await t.cancelar())).toEqual({ resultado: 'ProviderRefused', motivo: 'recusado_pelo_bling' });
    expect(t.linhas.get(TITULO)?.situacao).toBe('aberto');
  });

  it.each(['cancelado', 'estornado'])('título já %s: AlreadyTerminal, sem ir ao Bling', async (situacao) => {
    const t = montar({ titulos: [doBling(situacao)] });
    expect(await corpo(await t.cancelar())).toEqual({ resultado: 'AlreadyTerminal' });
    expect(t.consultarContaPagar).not.toHaveBeenCalled();
  });

  it('retry depois de ACK perdido: a leitura acha 404 e converge sem outro DELETE', async () => {
    const t = montar({
      titulos: [doBling()],
      leituras: [remota(1), { _tag: 'RemotoIndeterminado', causa: 'falha_de_rede' }, { _tag: 'RemotoAusente' }],
      exclusao: { _tag: 'RemotoIndeterminado', causa: 'prazo_esgotado' },
    });

    const primeira = await t.cancelar();
    const segunda = await t.cancelar();

    expect((await corpo(primeira)).resultado).toBe('ReconcileRequired');
    expect(await corpo(segunda)).toEqual({ resultado: 'Cancelled' });
    expect(t.excluirContaPagar).toHaveBeenCalledTimes(1);
  });

  it('removida no Bling mas o banco falhou: ReconcileRequired com conclusão pendente', async () => {
    const t = montar({ titulos: [doBling()], leituras: [remota(1)], marcarFalha: true });
    expect(await corpo(await t.cancelar())).toEqual({ resultado: 'ReconcileRequired', motivo: 'conclusao_local_pendente' });
  });

  it('despesa interna não é cancelada — é excluída', async () => {
    const t = montar({ titulos: [interna('aberto')] });
    expect(await corpo(await t.cancelar())).toEqual({ resultado: 'Blocked', motivo: 'despesa_interna' });
    expect(t.consultarContaPagar).not.toHaveBeenCalled();
  });

  it('outra organização: 404 e o Bling não é consultado', async () => {
    const t = montar({ titulos: [doBling('aberto', { organizacaoId: ORG_B })] });
    expect((await t.cancelar()).status).toBe(404);
    expect(t.consultarContaPagar).not.toHaveBeenCalled();
  });

  it('com pedido: Blocked, sem ir ao Bling', async () => {
    const t = montar({ titulos: [doBling('aberto', { pedidoId: '77777777-7777-4777-8777-777777777777' })] });
    expect(await corpo(await t.cancelar())).toEqual({ resultado: 'Blocked', motivo: 'vinculado_a_pedido' });
    expect(t.consultarContaPagar).not.toHaveBeenCalled();
  });
});
