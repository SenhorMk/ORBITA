import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { BlingFake } from './__testkit__/blingFake';
import { esperar } from './filaDeRequisicoes';
import type { PortasDoClienteBling } from './bling';
import type { TokenDoBling } from './blingToken';

/**
 * Ticket 31 — a fila de requisições sob prazo.
 *
 * Arquivo separado de `bling-situacoes.test.ts` porque o assunto é outro: lá é
 * a descoberta das situações; aqui é o comportamento do `enforceRateLimit`
 * quando um participante desiste no meio.
 *
 * **A fila espaça, não serializa.** Ela garante a ordem em que as vezes são
 * tomadas e o intervalo mínimo entre elas; a requisição HTTP segue sozinha
 * depois, e duas podem estar no ar ao mesmo tempo.
 *
 * Existe por causa de uma regressão que **passou** por 1441 testes: ao tornar a
 * fila abortável, quem desistia resolvia a própria porta na hora, e o sucessor
 * tomava a vez antes da hora dele. Nenhum teste exercitava três participantes,
 * então a ordem quebrou em silêncio.
 */

const fake = new BlingFake();
const ORG = '41414141-4141-4141-8141-414141414141';
// Importado dinamicamente: `src/services/bling` valida a configuração do
// Supabase no topo do módulo, e o `stubEnv` só existe dentro do `beforeAll`.
let BlingClient: typeof import('./bling').BlingClient;

/** Cliente com token instantâneo, para o assunto ser só a fila. */
function adapter(getAccessToken: () => Promise<string> = async () => 'token-de-teste') {
  const cliente = BlingClient.forOrganization(`${ORG}-${Math.random()}`);
  Object.defineProperty(cliente, 'getAccessToken', { value: getAccessToken, configurable: true });
  return cliente;
}

const json = (status: number, body: unknown) => ({ status, body: JSON.stringify(body) });

/**
 * Portas **completas**, sempre.
 *
 * A factory exige a composição inteira de propósito: uma versão anterior
 * aceitava peças parciais e completava o resto com Supabase e cofre reais, o
 * que deixava o teste meio dublado e meio real sem nada avisar.
 */
function portasDeTeste(over: { dormir?: PortasDoClienteBling['dormir']; token?: Partial<TokenDoBling> } = {}): PortasDoClienteBling {
  return {
    dormir: over.dormir ?? esperar,
    token: {
      obter: over.token?.obter ?? (async () => ({ _tag: 'TokenObtido', token: 'token-de-teste' })),
      renovar: over.token?.renovar ?? (async () => ({ _tag: 'TokenObtido', token: 'token-renovado' })),
    },
  };
}

const SITUACOES = {
  data: [{ id: 15, nome: 'Cancelado' }],
};

const MODULOS = {
  data: [{ id: 98765432, nome: 'Vendas', descricao: 'Pedidos de Venda', criarSituacoes: true }],
};

beforeAll(async () => {
  const baseUrl = await fake.iniciar();
  vi.stubEnv('BLING_API_BASE_URL', baseUrl);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://fila-test-000000.supabase.co');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'fila-test-service-role-key-000000');
  ({ BlingClient } = await import('./bling'));
});

afterEach(() => fake.limpar());

afterAll(async () => {
  vi.unstubAllEnvs();
  await fake.parar();
});

describe('o prazo alcança o token e o backoff', () => {
  it('a capacidade de token fica dentro da seam, e não entrega token depois do prazo', async () => {
    // Obtenção e renovação são **a mesma** capacidade, então dublar uma sem a
    // outra deixou de ser possível — era isso que obrigava a substituir método
    // por método com `Object.defineProperty` e fazia a prova desviar da linha
    // em questão.
    // O contador mede o que a capacidade **concluiu**, e o nome diz isso: a
    // versão anterior chamava isto de `renovacoes` e contava o término de
    // `obter`, que não é a mesma coisa. A prova de que a renovação em si não
    // começa fora do prazo está em `blingToken.test.ts`, onde ela é observável.
    let tokensEntregues = 0;

    const cliente = BlingClient.comPortas(`${ORG}-${Math.random()}`, portasDeTeste({
      token: {
        obter: async (signal) => {
          // Simula o custo real: a leitura da credencial é ida à rede.
          await new Promise((r) => setTimeout(r, 300));
          if (signal?.aborted) return { _tag: 'TokenFalhou', falha: { motivo: 'prazo-esgotado', mensagem: 'prazo' } };
          tokensEntregues += 1;
          return { _tag: 'TokenObtido', token: 'token-renovado' };
        },
      },
    }));

    const original = BlingClient.TEMPO_LIMITE_OPERACAO_MS;
    Object.defineProperty(BlingClient, 'TEMPO_LIMITE_OPERACAO_MS', { value: 80, configurable: true });

    try {
      const resultado = await cliente.obterSituacoesDePedidoDeVenda();
      expect(resultado._tag).toBe('BlingFailed');

      // Esperar o trabalho de fundo assentar antes de afirmar: a chamada volta
      // em 80 ms, antes de a credencial responder, e o contador ficaria em zero
      // de qualquer jeito. A asserção seria sobre o relógio.
      await new Promise((r) => setTimeout(r, 600));

      expect(tokensEntregues).toBe(0);
      expect(fake.recebidas).toHaveLength(0);
    } finally {
      Object.defineProperty(BlingClient, 'TEMPO_LIMITE_OPERACAO_MS', { value: original, configurable: true });
    }
  });

  it('o backoff de 429 recebe o prazo — a ligação, e não só o efeito', async () => {
    // **A prova do call site**, que faltava. Pelo lado de fora não dá para
    // distinguir: a conferência no topo do laço já impede a repetição depois do
    // prazo, então uma espera não-cancelável devolveria a mesma resposta.
    //
    // Com a espera injetada, dá para olhar o que o ramo do 429 realmente passa
    // adiante — e é isso que a correção mudou.
    const esperasDoBackoff: Array<{ ms: number; recebeuPrazo: boolean }> = [];

    const cliente = BlingClient.comPortas(`${ORG}-${Math.random()}`, portasDeTeste({
      dormir: async (ms, signal) => {
        // A fila também usa esta porta; só o backoff pede segundos.
        if (ms >= 1_000) esperasDoBackoff.push({ ms, recebeuPrazo: signal !== undefined });
        if (signal) await esperar(5, signal);
      },
    }));

    fake.programar(
      { status: 429, body: '{}', headers: { 'Retry-After': '2' } },
      json(200, MODULOS),
      json(200, SITUACOES),
    );

    await cliente.obterSituacoesDePedidoDeVenda();

    expect(esperasDoBackoff).toHaveLength(1);
    expect(esperasDoBackoff[0]?.ms).toBe(2_000);
    // A ligação: o ramo do 429 entrega o prazo à espera. Sem isso, o backoff
    // dorme os 2 s inteiros mesmo com a operação já abandonada.
    expect(esperasDoBackoff[0]?.recebeuPrazo).toBe(true);
  });
});

describe('o corpo de uma resposta recusada não é lido', () => {
  it('um corpo que nunca termina não prende a chamada', async () => {
    // **O discriminador.** Um corpo finito, mesmo de 2 MB, termina nos dois
    // casos — `cancel()` e `text()` — e o teste não vê diferença. Foi assim que
    // a versão anterior desta prova ficou verde sem provar nada.
    //
    // Com um corpo que não acaba, `await response.text()` fica preso até o
    // prazo da operação estourar; `cancel()` devolve na hora. A diferença
    // aparece no resultado: falha de leitura com o status certo, ou falha
    // genérica por prazo esgotado.
    const cliente = adapter();
    fake.programar({ status: 500, body: 'x'.repeat(1024), corpoInterminavel: true });

    const original = BlingClient.TEMPO_LIMITE_OPERACAO_MS;
    Object.defineProperty(BlingClient, 'TEMPO_LIMITE_OPERACAO_MS', { value: 2_000, configurable: true });

    try {
      const resultado = await cliente.obterSituacoesDePedidoDeVenda();

      if (resultado._tag !== 'BlingFailed') throw new Error('esperava falha');
      // O status sobreviveu: ele já era conhecido antes de o corpo existir, e o
      // corpo não chegou a ser esperado.
      expect(resultado.failure.status).toBe(500);
      expect(resultado.failure.message).toMatch(/indisponível/iu);
    } finally {
      Object.defineProperty(BlingClient, 'TEMPO_LIMITE_OPERACAO_MS', { value: original, configurable: true });
    }
  });
});
