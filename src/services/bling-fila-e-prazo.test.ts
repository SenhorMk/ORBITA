import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { BlingFake } from './__testkit__/blingFake';

/**
 * O cofre é a fronteira dublada, e não o `getAccessToken`.
 *
 * Dublar o método inteiro desviaria da linha que a correção mudou — foi o
 * defeito da versão anterior desta prova.
 */
const lerCredenciais = vi.fn();

/**
 * A conexão é resolvida por consulta ao Supabase antes de o cofre ser lido.
 * Sem este dublê, `getAccessToken` para antes com "Bling nao conectado" e a
 * linha em prova nunca é alcançada.
 */
vi.mock('../lib/supabaseServer', () => ({
  supabaseServer: {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: { id: 'conexao-de-teste' }, error: null }) }),
        }),
      }),
    }),
  },
}));
vi.mock('../lib/integrations/credentialsVault', () => ({
  credentialsVault: {
    getDecryptedCredentials: (...args: unknown[]) => lerCredenciais(...args),
  },
}));

/**
 * Ticket 31 — a fila de requisições sob prazo.
 *
 * Arquivo separado de `bling-situacoes.test.ts` porque o assunto é outro: lá é
 * a descoberta das situações; aqui é o comportamento do `enforceRateLimit`
 * quando um participante desiste no meio.
 *
 * Existe por causa de uma regressão que **passou** por 1441 testes: ao tornar a
 * fila abortável, quem desistia resolvia a própria porta na hora, e o sucessor
 * ultrapassava um predecessor que ainda estava requisitando. Nenhum teste
 * exercitava três chamadas concorrentes, então a ordem quebrou em silêncio.
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
  it('não inicia a renovação de um token já vencido depois do prazo', async () => {
    // **Exercita o `getAccessToken` real.** A versão anterior substituía o
    // método inteiro por um dublê — e assim desviava exatamente da linha que a
    // correção mudou. O que se dubla aqui é o **cofre**, uma camada abaixo, que
    // é a fronteira legítima.
    //
    // O cofre devolve um token já vencido e demora a responder: quando ele
    // volta, o orçamento já acabou, e a renovação não pode começar. Ela faz
    // polling de lock com `await` de banco, então é o pior gasto possível.
    let renovacoes = 0;
    lerCredenciais.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 300));
      return {
        access_token: 'token-vencido',
        client_id: 'id',
        client_secret: 'segredo',
        refresh_token: 'refresh',
        token_expires_at: new Date(Date.now() - 60_000).toISOString(),
      };
    });

    const cliente = BlingClient.forOrganization(`${ORG}-${Math.random()}`);
    Object.defineProperty(cliente, 'forceRefreshToken', {
      value: async () => { renovacoes += 1; return 'token-novo'; },
      configurable: true,
    });

    const original = BlingClient.TEMPO_LIMITE_OPERACAO_MS;
    Object.defineProperty(BlingClient, 'TEMPO_LIMITE_OPERACAO_MS', { value: 80, configurable: true });

    try {
      const resultado = await cliente.obterSituacoesDePedidoDeVenda();

      expect(resultado._tag).toBe('BlingFailed');

      // **Esperar o trabalho de fundo assentar antes de afirmar.** A chamada
      // volta ao chamador em 80 ms, mas o caminho continua correndo por trás —
      // é o resíduo conhecido. Afirmar imediatamente veria `renovacoes === 0`
      // mesmo sem a guarda, só porque o cofre ainda não tinha respondido: a
      // asserção seria sobre o relógio, não sobre a causa.
      await new Promise((r) => setTimeout(r, 600));

      // Agora sim: a leitura do cofre aconteceu, o token estava vencido, e
      // mesmo assim a renovação **não** foi iniciada.
      expect(lerCredenciais).toHaveBeenCalled();
      expect(renovacoes).toBe(0);
      expect(fake.recebidas).toHaveLength(0);
    } finally {
      Object.defineProperty(BlingClient, 'TEMPO_LIMITE_OPERACAO_MS', { value: original, configurable: true });
      lerCredenciais.mockReset();
    }
  });

  it('o backoff de 429 é interrompido, e não apenas abandonado', async () => {
    // "Voltou antes do `Retry-After`" não distingue nada: a corrida externa
    // devolve o controle de qualquer jeito, e a espera pode continuar dormindo
    // por trás para depois **repetir a requisição**. Foi o que a versão
    // anterior desta prova deixou passar.
    //
    // O que distingue é o silêncio depois: se a espera tivesse sobrevivido, uma
    // segunda requisição chegaria ao servidor quando ela acordasse.
    const cliente = adapter();
    fake.programar(
      { status: 429, body: '{}', headers: { 'Retry-After': '1' } },
      json(200, MODULOS),
    );

    const original = BlingClient.TEMPO_LIMITE_OPERACAO_MS;
    Object.defineProperty(BlingClient, 'TEMPO_LIMITE_OPERACAO_MS', { value: 200, configurable: true });

    try {
      const resultado = await cliente.obterSituacoesDePedidoDeVenda();
      expect(resultado._tag).toBe('BlingFailed');
      expect(fake.recebidas).toHaveLength(1);

      // O backoff teria sido de 1 s. Passado bem mais que isso, a segunda
      // requisição continua não existindo.
      await new Promise((r) => setTimeout(r, 1_600));
      expect(fake.recebidas).toHaveLength(1);
    } finally {
      Object.defineProperty(BlingClient, 'TEMPO_LIMITE_OPERACAO_MS', { value: original, configurable: true });
    }
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
