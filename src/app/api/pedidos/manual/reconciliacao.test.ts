/**
 * Ticket 30, fatia 3 — 5ª rodada de revisão.
 *
 * A revisão aceitou o bloqueio de uma tentativa indeterminada como o
 * comportamento seguro, e apontou o que faltava: um caminho de saída. Sem ele,
 * "seguro" vira "esta venda está bloqueada para sempre; limpe o localStorage" —
 * e apagar a chave de idempotência é justamente furar a proteção.
 *
 * Estes testes fixam o ciclo `indeterminada → reconciliar → concluída/falhou →
 * liberada`, incluindo o caso mais difícil, que é o que a revisão pediu para
 * provar: reconciliar uma tentativa que NÃO tem `bling_id`, usando só a
 * `referenciaLocal` que viajou ao Bling em `numeroLoja`.
 */
import { describe, expect, it } from 'vitest';

import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';

import {
  reconciliarTentativa,
  respostaDaReconciliacao,
  tentativaPodeSerReconciliada,
  type ReconciliacaoDeps,
} from './reconciliacao';
import type {
  DesfechoDaTentativa,
  PedidoEncontradoNoBling,
  TentativaRegistrada,
} from './ports';

const ORG = '11111111-1111-4111-8111-111111111111';
const scope = { organizationId: ORG, actorId: 'ator', role: 'owner' } as unknown as VerifiedOrganizationScope;
const REFERENCIA = 'ORBITA-55555555-5555-4555-8555-555555555555';
const AGORA = new Date('2026-09-03T12:00:00.000Z');

function tentativa(overrides: Partial<TentativaRegistrada> = {}): TentativaRegistrada {
  return {
    id: 'tentativa-1',
    estado: 'indeterminada',
    pedidoId: null,
    // O caso difícil por padrão: NENHUM bling_id — o ACK da criação se perdeu.
    blingPedidoId: null,
    atualizadaEm: '2026-09-03T11:00:00.000Z',
    ...overrides,
  };
}

interface Dublês {
  readonly deps: ReconciliacaoDeps;
  readonly desfechos: DesfechoDaTentativa[];
  readonly numerosLojaConsultados: string[];
}

function dubles(options: {
  pedidoEncontrado?: PedidoEncontradoNoBling | null;
  buscaFalhou?: string;
  vendaLocalPedidoId?: string;
} = {}): Dublês {
  const desfechos: DesfechoDaTentativa[] = [];
  const numerosLojaConsultados: string[] = [];

  const deps = {
    now: () => AGORA,
    store: {
      async registrarDesfechoDaTentativa(
        _scope: VerifiedOrganizationScope,
        _tentativaId: string,
        desfecho: DesfechoDaTentativa,
      ) {
        desfechos.push(desfecho);
      },
      async findVendaManualJaRegistrada() {
        return options.vendaLocalPedidoId ? { pedidoId: options.vendaLocalPedidoId } : null;
      },
    },
    bling: {
      async buscarPedidoPorNumeroLoja(numeroLoja: string) {
        numerosLojaConsultados.push(numeroLoja);
        if (options.buscaFalhou) {
          return {
            _tag: 'BlingFailed' as const,
            failure: { _tag: 'BlingProviderFailure' as const, type: 'SERVER_ERROR', status: 500, message: options.buscaFalhou, duplicateSale: false },
          };
        }
        return { _tag: 'BlingOk' as const, value: options.pedidoEncontrado ?? null };
      },
    },
  } as unknown as ReconciliacaoDeps;

  return { deps, desfechos, numerosLojaConsultados };
}

describe('tentativaPodeSerReconciliada', () => {
  it('uma tentativa indeterminada pode ser reconciliada — é exatamente para ela que a saída existe', () => {
    expect(tentativaPodeSerReconciliada(tentativa(), AGORA).pode).toBe(true);
  });

  it('uma tentativa EM ANDAMENTO recente NÃO pode: pode estar em voo agora, e concluí-la por cima seria decidir por ela', () => {
    const resultado = tentativaPodeSerReconciliada(
      tentativa({ estado: 'em_andamento', atualizadaEm: new Date(AGORA.getTime() - 5_000).toISOString() }),
      AGORA,
    );
    expect(resultado.pode).toBe(false);
  });

  it('uma tentativa EM ANDAMENTO antiga pode: passou muito da janela de confirmação, então está travada mesmo', () => {
    const resultado = tentativaPodeSerReconciliada(
      tentativa({ estado: 'em_andamento', atualizadaEm: new Date(AGORA.getTime() - 10 * 60 * 1000).toISOString() }),
      AGORA,
    );
    expect(resultado.pode).toBe(true);
  });

  it.each([
    ['concluida' as const],
    ['falhou' as const],
  ])('uma tentativa já terminal (%s) não tem o que reconciliar', (estado) => {
    expect(tentativaPodeSerReconciliada(tentativa({ estado }), AGORA).pode).toBe(false);
  });
});

describe('reconciliarTentativa — sem bling_id, só pela referência local', () => {
  it('o Bling NÃO tem o pedido: nada foi criado, a tentativa vira falhou e a referência é LIBERADA', async () => {
    const { deps, desfechos, numerosLojaConsultados } = dubles({ pedidoEncontrado: null });

    const resultado = await reconciliarTentativa(scope, REFERENCIA, tentativa(), deps);

    // Perguntou pela referência local — a única coisa que os dois lados
    // compartilham quando o `bling_id` nunca chegou.
    expect(numerosLojaConsultados).toEqual([REFERENCIA]);
    expect(resultado._tag).toBe('NadaFoiCriado');
    expect(desfechos).toEqual([{ estado: 'falhou' }]);

    const resposta = respostaDaReconciliacao(resultado);
    expect(resposta.status).toBe(200);
    expect(await resposta.json()).toMatchObject({ referenciaLiberada: true, situacao: 'nada_foi_criado' });
  });

  it('os DOIS lados têm a venda: só a confirmação se perdeu — vira concluida e a referência é LIBERADA', async () => {
    const { deps, desfechos } = dubles({
      pedidoEncontrado: { id: '918273', numeroLoja: REFERENCIA, situacao: 'Em aberto' },
      vendaLocalPedidoId: 'pedido-local-7',
    });

    const resultado = await reconciliarTentativa(scope, REFERENCIA, tentativa(), deps);

    expect(resultado._tag).toBe('VendaConfirmada');
    expect(desfechos).toEqual([{ estado: 'concluida', pedidoId: 'pedido-local-7', blingPedidoId: '918273' }]);

    const resposta = respostaDaReconciliacao(resultado);
    expect(resposta.status).toBe(200);
    expect(await resposta.json()).toMatchObject({ referenciaLiberada: true, situacao: 'venda_confirmada', pedidoId: 'pedido-local-7' });
  });

  it('o pedido existe no Bling e a venda NÃO existe aqui: continua bloqueada, mas agora com o bling_id descoberto', async () => {
    const { deps, desfechos } = dubles({
      pedidoEncontrado: { id: '918273', numeroLoja: REFERENCIA, situacao: 'Em aberto' },
    });

    const resultado = await reconciliarTentativa(scope, REFERENCIA, tentativa(), deps);

    expect(resultado._tag).toBe('PendenteNoBling');
    // O ganho concreto: o id que faltava passa a estar gravado na tentativa.
    // Sem isto, "não se sabe o que aconteceu"; com isto, "o pedido 918273
    // existe lá e não existe aqui".
    expect(desfechos).toEqual([{ estado: 'indeterminada', blingPedidoId: '918273' }]);

    const resposta = respostaDaReconciliacao(resultado);
    // NÃO libera: resolver exige escrever em um dos dois lados, e isso não é
    // decisão de uma reconciliação automática.
    expect(resposta.status).toBe(409);
    expect(await resposta.json()).toMatchObject({ referenciaLiberada: false, situacao: 'pendente_no_bling', blingPedidoId: '918273' });
  });

  it('a consulta ao Bling falha: NÃO conclui nada e NÃO libera — o desconhecido continua desconhecido', async () => {
    const { deps, desfechos } = dubles({ buscaFalhou: 'gateway indisponível' });

    const resultado = await reconciliarTentativa(scope, REFERENCIA, tentativa(), deps);

    expect(resultado._tag).toBe('NaoReconciliavel');
    // O ponto: nenhuma gravação de desfecho. Falhar a consulta não é evidência
    // de nada, e concluir aqui seria adivinhar.
    expect(desfechos).toEqual([]);

    const resposta = respostaDaReconciliacao(resultado);
    expect(resposta.status).toBe(503);
    expect(await resposta.json()).toMatchObject({ referenciaLiberada: false, situacao: 'nao_reconciliavel' });
  });

  it('nunca escreve no Bling: a reconciliação é só leitura', async () => {
    const cancelamentos: string[] = [];
    const { deps } = dubles({ pedidoEncontrado: { id: '918273', numeroLoja: REFERENCIA, situacao: 'Em aberto' } });
    const depsComEspiao = {
      ...deps,
      bling: {
        ...deps.bling,
        cancelarPedidoVenda: async (id: string) => {
          cancelamentos.push(id);
          return { _tag: 'BlingOk' as const, value: undefined };
        },
      },
    } as unknown as ReconciliacaoDeps;

    await reconciliarTentativa(scope, REFERENCIA, tentativa(), depsComEspiao);

    expect(cancelamentos).toEqual([]);
  });
});
