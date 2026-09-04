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
  BuscaDePedidoPorNumeroLoja,
  DesfechoDaTentativa,
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
  pedidoEncontrado?: BuscaDePedidoPorNumeroLoja;
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
        return { _tag: 'BlingOk' as const, value: options.pedidoEncontrado ?? { _tag: 'NenhumPedido' as const } };
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
  it('o Bling NÃO tem o pedido: a AUSÊNCIA não conclui nada e NÃO libera a chave', async () => {
    const { deps, desfechos, numerosLojaConsultados } = dubles({ pedidoEncontrado: { _tag: 'NenhumPedido' } });

    const resultado = await reconciliarTentativa(scope, REFERENCIA, tentativa(), deps);

    // Perguntou pela referência local — a única coisa que os dois lados
    // compartilham quando o `bling_id` nunca chegou.
    expect(numerosLojaConsultados).toEqual([REFERENCIA]);
    // 7ª rodada: "o GET não achou agora" não é "o POST nunca criou". O
    // contrato do Bling não promete visibilidade imediata, então concluir
    // aqui reabriria a chave numa janela em que o pedido pode existir e ainda
    // não estar listado.
    expect(resultado._tag).toBe('NenhumPedidoVisivel');
    expect(desfechos).toEqual([]);

    const resposta = respostaDaReconciliacao(resultado);
    expect(resposta.status).toBe(409);
    expect(await resposta.json()).toMatchObject({ referenciaLiberada: false, situacao: 'nenhum_pedido_visivel' });
  });

  it('os DOIS lados têm a venda: só a confirmação se perdeu — vira concluida e a referência é LIBERADA', async () => {
    const { deps, desfechos } = dubles({
      pedidoEncontrado: { _tag: 'UmPedido', pedido: { id: '918273', numeroLoja: REFERENCIA, situacao: 'Em aberto' } },
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
      pedidoEncontrado: { _tag: 'UmPedido', pedido: { id: '918273', numeroLoja: REFERENCIA, situacao: 'Em aberto' } },
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
    const { deps } = dubles({ pedidoEncontrado: { _tag: 'UmPedido', pedido: { id: '918273', numeroLoja: REFERENCIA, situacao: 'Em aberto' } } });
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

describe('6ª rodada — cardinalidade explícita da busca por numeroLoja (0/1/N)', () => {
  it('ZERO correspondências exatas: não conclui e não libera — ausência não é prova', async () => {
    const { deps, desfechos } = dubles({ pedidoEncontrado: { _tag: 'NenhumPedido' } });

    const resultado = await reconciliarTentativa(scope, REFERENCIA, tentativa(), deps);

    expect(resultado._tag).toBe('NenhumPedidoVisivel');
    expect(desfechos).toEqual([]);
  });

  it('EXATAMENTE UMA: associa o bling_id e segue a máquina de reconciliação', async () => {
    const { deps, desfechos } = dubles({
      pedidoEncontrado: { _tag: 'UmPedido', pedido: { id: '918273', numeroLoja: REFERENCIA, situacao: 'Em aberto' } },
    });

    const resultado = await reconciliarTentativa(scope, REFERENCIA, tentativa(), deps);

    expect(resultado._tag).toBe('PendenteNoBling');
    expect(desfechos).toEqual([{ estado: 'indeterminada', blingPedidoId: '918273' }]);
  });

  it('MAIS DE UMA: permanece ambígua — NUNCA escolhe "o primeiro"', async () => {
    const { deps, desfechos } = dubles({
      pedidoEncontrado: { _tag: 'VariosPedidos', quantidade: 2, ids: ['918273', '918274'] },
    });

    const resultado = await reconciliarTentativa(scope, REFERENCIA, tentativa(), deps);

    expect(resultado._tag).toBe('NaoReconciliavel');
    // O ponto: nenhum desfecho é gravado. Associar a tentativa a um dos dois
    // seria concluir a venda com o pedido errado em metade dos casos.
    expect(desfechos).toEqual([]);

    const resposta = respostaDaReconciliacao(resultado);
    expect(resposta.status).toBe(409);
    const corpo = await resposta.json();
    expect(corpo.referenciaLiberada).toBe(false);
    expect(corpo.mensagem).toContain('2 pedidos');
  });
});

describe('6ª rodada — o caminho terminal de "Bling tem, ORBITA não tem"', () => {
  function dublesComCancelamento(options: { cancelamentoFalha?: string; claimOcupado?: boolean } = {}) {
    const cancelados: string[] = [];
    const desfechos: DesfechoDaTentativa[] = [];
    const intervencoes: Array<Record<string, unknown>> = [];
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
          return null;
        },
        async reivindicarIntervencao(
          _scope: VerifiedOrganizationScope,
          _tentativaId: string,
          acao: string,
          blingPedidoId: string | null,
        ) {
          if (options.claimOcupado) return { _tag: 'IntervencaoJaEmAndamento' as const };
          intervencoes.push({ fase: 'reivindicada', acao, blingPedidoId });
          return { _tag: 'IntervencaoReivindicada' as const, intervencaoId: 'intervencao-1' };
        },
        async encerrarIntervencao(
          _scope: VerifiedOrganizationScope,
          _intervencaoId: string,
          resultado: string,
        ) {
          intervencoes.push({ fase: 'encerrada', resultado });
        },
      },
      bling: {
        async buscarPedidoPorNumeroLoja() {
          return {
            _tag: 'BlingOk' as const,
            value: { _tag: 'UmPedido' as const, pedido: { id: '918273', numeroLoja: REFERENCIA, situacao: 'Em aberto' } },
          };
        },
        async cancelarPedidoVenda(id: string) {
          if (options.cancelamentoFalha) {
            return {
              _tag: 'BlingFailed' as const,
              failure: { _tag: 'BlingProviderFailure' as const, type: 'SERVER_ERROR', status: 500, message: options.cancelamentoFalha, duplicateSale: false },
            };
          }
          cancelados.push(id);
          return { _tag: 'BlingOk' as const, value: undefined };
        },
      },
    } as unknown as ReconciliacaoDeps;
    return { deps, cancelados, desfechos, intervencoes };
  }

  it('sem ação explícita, NÃO cancela nada — conferir é só leitura', async () => {
    const { deps, cancelados } = dublesComCancelamento();

    const resultado = await reconciliarTentativa(scope, REFERENCIA, tentativa(), deps);

    expect(resultado._tag).toBe('PendenteNoBling');
    expect(cancelados).toEqual([]);
  });

  it('com a ação explícita e cancelamento CONFIRMADO: encerra como falhou e LIBERA a referência', async () => {
    const { deps, cancelados, desfechos, intervencoes } = dublesComCancelamento();

    const resultado = await reconciliarTentativa(scope, REFERENCIA, tentativa(), deps, 'cancelar-no-bling');

    expect(cancelados).toEqual(['918273']);
    expect(resultado._tag).toBe('CanceladoNoBling');
    // Grava o bling_id descoberto antes de cancelar, e só então encerra.
    expect(desfechos).toEqual([
      { estado: 'indeterminada', blingPedidoId: '918273' },
      { estado: 'falhou', blingPedidoId: '918273' },
    ]);
    // O claim foi reivindicado e encerrado como confirmado: é o rastro.
    expect(intervencoes).toEqual([
      { fase: 'reivindicada', acao: 'cancelar-no-bling', blingPedidoId: '918273' },
      { fase: 'encerrada', resultado: 'confirmada' },
    ]);

    const resposta = respostaDaReconciliacao(resultado);
    expect(resposta.status).toBe(200);
    expect(await resposta.json()).toMatchObject({ referenciaLiberada: true, situacao: 'cancelado_no_bling' });
  });

  it('cancelamento FALHA: continua indeterminada e NÃO libera — só compensação confirmada encerra', async () => {
    const { deps, desfechos, intervencoes } = dublesComCancelamento({ cancelamentoFalha: 'gateway fora do ar' });

    const resultado = await reconciliarTentativa(scope, REFERENCIA, tentativa(), deps, 'cancelar-no-bling');

    expect(resultado._tag).toBe('NaoReconciliavel');
    // Nenhum `falhou` gravado: o pedido pode continuar existindo lá.
    expect(desfechos).toEqual([{ estado: 'indeterminada', blingPedidoId: '918273' }]);
    // E o rastro registra a falha, em vez de sumir.
    expect(intervencoes[1]).toMatchObject({ fase: 'encerrada', resultado: 'falhou' });

    const resposta = respostaDaReconciliacao(resultado);
    expect(resposta.status).toBe(502);
    expect(await resposta.json()).toMatchObject({ referenciaLiberada: false });
  });
});

describe('7ª rodada — visibilidade atrasada: a ausência nunca libera a chave', () => {
  /**
   * O cenário exato que a revisão pediu:
   *
   *   1. a criação devolve estado ambíguo;
   *   2. a PRIMEIRA consulta por `numeroLoja` devolve zero;
   *   3. uma consulta POSTERIOR encontra exatamente um pedido;
   *   4. entre 2 e 3 a chave não pode ser liberada, e nenhuma segunda criação
   *      pode chegar ao Bling.
   *
   * O que torna isso seguro não é esperar N segundos — é a ausência não
   * concluir nada. Nenhum número de tentativas aparece nesta prova.
   */
  function dublesComVisibilidadeAtrasada() {
    const desfechos: DesfechoDaTentativa[] = [];
    let consultas = 0;
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
          return null;
        },
      },
      bling: {
        async buscarPedidoPorNumeroLoja() {
          consultas += 1;
          // A primeira consulta não enxerga o pedido; a segunda enxerga.
          if (consultas === 1) return { _tag: 'BlingOk' as const, value: { _tag: 'NenhumPedido' as const } };
          return {
            _tag: 'BlingOk' as const,
            value: { _tag: 'UmPedido' as const, pedido: { id: '918273', numeroLoja: REFERENCIA, situacao: 'Em aberto' } },
          };
        },
      },
    } as unknown as ReconciliacaoDeps;
    return { deps, desfechos, consultas: () => consultas };
  }

  it('primeira consulta vazia NÃO libera; a segunda encontra o pedido e a tentativa segue bloqueada', async () => {
    const { deps, desfechos } = dublesComVisibilidadeAtrasada();

    const primeira = await reconciliarTentativa(scope, REFERENCIA, tentativa(), deps);
    expect(primeira._tag).toBe('NenhumPedidoVisivel');
    // O ponto central: nada foi concluído, então a chave continua bloqueada e
    // nenhuma segunda criação pode partir daqui.
    expect(desfechos).toEqual([]);
    expect(respostaDaReconciliacao(primeira).status).toBe(409);

    const segunda = await reconciliarTentativa(scope, REFERENCIA, tentativa(), deps);
    expect(segunda._tag).toBe('PendenteNoBling');
    // E agora o `bling_id` que existia o tempo todo é gravado.
    expect(desfechos).toEqual([{ estado: 'indeterminada', blingPedidoId: '918273' }]);
  });

  it('encerrar como não criada é uma DECISÃO explícita, não uma dedução da consulta vazia', async () => {
    const { deps, desfechos } = dublesComVisibilidadeAtrasada();

    const semAcao = await reconciliarTentativa(scope, REFERENCIA, tentativa(), deps);
    expect(semAcao._tag).toBe('NenhumPedidoVisivel');
    expect(desfechos).toEqual([]);
  });

  it('com a ação explícita, a consulta vazia encerra e libera — a responsabilidade é de quem conferiu', async () => {
    const { deps, desfechos } = dubles({ pedidoEncontrado: { _tag: 'NenhumPedido' } });

    const resultado = await reconciliarTentativa(scope, REFERENCIA, tentativa(), deps, 'encerrar-como-nao-criada');

    expect(resultado._tag).toBe('EncerradaComoNaoCriada');
    expect(desfechos).toEqual([{ estado: 'falhou' }]);
    const resposta = respostaDaReconciliacao(resultado);
    expect(resposta.status).toBe(200);
    expect(await resposta.json()).toMatchObject({ referenciaLiberada: true, situacao: 'encerrada_como_nao_criada' });
  });
});

describe('7ª rodada — CAS: a reconciliação não sobrescreve quem produziu o efeito', () => {
  it('a reconciliação passa o estado que leu, para o banco recusar se ele mudou', async () => {
    const chamadas: Array<{ estadoEsperado: unknown }> = [];
    const deps = {
      now: () => AGORA,
      store: {
        async registrarDesfechoDaTentativa(
          _scope: VerifiedOrganizationScope,
          _tentativaId: string,
          _desfecho: DesfechoDaTentativa,
          estadoEsperado?: string,
        ) {
          chamadas.push({ estadoEsperado });
        },
        async findVendaManualJaRegistrada() {
          return { pedidoId: 'pedido-local-1' };
        },
      },
      bling: {
        async buscarPedidoPorNumeroLoja() {
          return {
            _tag: 'BlingOk' as const,
            value: { _tag: 'UmPedido' as const, pedido: { id: '918273', numeroLoja: REFERENCIA, situacao: 'Em aberto' } },
          };
        },
      },
    } as unknown as ReconciliacaoDeps;

    await reconciliarTentativa(scope, REFERENCIA, tentativa({ estado: 'em_andamento' }), deps);

    // Idade não é sincronização: sem passar o estado lido, uma reconciliação
    // disparada por idade sobrescreveria o desfecho de uma requisição ainda em
    // voo. O CAS é o que impede isso, e é imposto pelo banco.
    expect(chamadas).toEqual([{ estadoEsperado: 'em_andamento' }]);
  });

  it('quando o CAS perde, a reconciliação NÃO relata sucesso — propaga a falha', async () => {
    const deps = {
      now: () => AGORA,
      store: {
        async registrarDesfechoDaTentativa() {
          throw new Error('O estado da tentativa mudou durante a operação; nada foi gravado.');
        },
        async findVendaManualJaRegistrada() {
          return { pedidoId: 'pedido-local-1' };
        },
      },
      bling: {
        async buscarPedidoPorNumeroLoja() {
          return {
            _tag: 'BlingOk' as const,
            value: { _tag: 'UmPedido' as const, pedido: { id: '918273', numeroLoja: REFERENCIA, situacao: 'Em aberto' } },
          };
        },
      },
    } as unknown as ReconciliacaoDeps;

    await expect(
      reconciliarTentativa(scope, REFERENCIA, tentativa({ estado: 'em_andamento' }), deps),
    ).rejects.toThrow(/estado da tentativa mudou/iu);
  });
});

describe('7ª rodada — claim: duas intervenções simultâneas, uma só chamada ao ERP', () => {
  it('a segunda requisição de cancelamento é recusada pelo claim, sem tocar o Bling', async () => {
    const { deps, cancelados } = dublesComClaimOcupado();

    const resultado = await reconciliarTentativa(scope, REFERENCIA, tentativa(), deps, 'cancelar-no-bling');

    expect(resultado._tag).toBe('NaoReconciliavel');
    // O ponto: NENHUMA chamada ao ERP. A exclusão é nossa, não delegada a uma
    // suposta idempotência do provedor.
    expect(cancelados).toEqual([]);
    expect(respostaDaReconciliacao(resultado).status).toBe(409);
  });

  function dublesComClaimOcupado() {
    const cancelados: string[] = [];
    const deps = {
      now: () => AGORA,
      store: {
        async registrarDesfechoDaTentativa() { /* irrelevante aqui */ },
        async findVendaManualJaRegistrada() { return null; },
        async reivindicarIntervencao() { return { _tag: 'IntervencaoJaEmAndamento' as const }; },
        async encerrarIntervencao() { /* nunca chamado */ },
      },
      bling: {
        async buscarPedidoPorNumeroLoja() {
          return {
            _tag: 'BlingOk' as const,
            value: { _tag: 'UmPedido' as const, pedido: { id: '918273', numeroLoja: REFERENCIA, situacao: 'Em aberto' } },
          };
        },
        async cancelarPedidoVenda(id: string) {
          cancelados.push(id);
          return { _tag: 'BlingOk' as const, value: undefined };
        },
      },
    } as unknown as ReconciliacaoDeps;
    return { deps, cancelados };
  }
});
