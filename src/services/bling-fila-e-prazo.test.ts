import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { BlingFake } from './__testkit__/blingFake';

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
let PortaDaFila: typeof import('./bling').PortaDaFila;

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
  ({ BlingClient, PortaDaFila } = await import('./bling'));
});

afterEach(() => fake.limpar());

afterAll(async () => {
  vi.unstubAllEnvs();
  await fake.parar();
});

/**
 * A porta é testada **diretamente**, e não só através do cliente.
 *
 * A primeira tentativa de provar isto foi por três chamadas concorrentes, e ela
 * passava com a regressão reintroduzida — porque o espaçamento de 340 ms vem de
 * `lastRequestTime`, não da porta, e continuava igual nos dois casos. Um teste
 * que não distingue o defeito não é prova, por mais realista que pareça.
 *
 * O que a porta promete é encadeamento, e é isso que se afirma aqui.
 */
describe('PortaDaFila', () => {
  it('liberar() abre a porta na hora', async () => {
    const porta = new PortaDaFila();
    let aberta = false;
    void porta.aberta.then(() => { aberta = true; });

    porta.liberar();
    await porta.aberta;

    expect(aberta).toBe(true);
  });

  it('encadearEm() NÃO abre enquanto o predecessor não terminar', async () => {
    // O cenário A → B → C: B desiste esperando A, e a porta de B é o que C
    // aguarda. Se ela abrisse na desistência, C ultrapassaria A.
    let liberarA = (): void => {};
    const a = new Promise<void>((resolve) => { liberarA = resolve; });

    const portaDeB = new PortaDaFila();
    let bAberta = false;
    void portaDeB.aberta.then(() => { bAberta = true; });

    portaDeB.encadearEm(a);

    // Vários tiques: se fosse abrir sozinha, abriria aqui.
    await new Promise((r) => setTimeout(r, 50));
    expect(bAberta).toBe(false);

    liberarA();
    await portaDeB.aberta;
    expect(bAberta).toBe(true);
  });

  it('encadearEm() abre também quando o predecessor falha', async () => {
    // A fila não pode travar porque alguém antes quebrou.
    const a = Promise.reject(new Error('o predecessor falhou'));
    const porta = new PortaDaFila();

    porta.encadearEm(a);

    await expect(porta.aberta).resolves.toBeUndefined();
  });
});

describe('a fila preserva a ordem quando alguém desiste', () => {
  it('A → B → C: C não chega antes de A', async () => {
    // Prova de integração, mais fraca que a da porta de propósito: afirma a
    // **ordem de chegada**, que é o efeito visível do encadeamento.
    const cliente = adapter();

    fake.programar(
      { status: 200, body: JSON.stringify(MODULOS), atrasoMs: 900 },
      json(200, MODULOS),
      json(200, MODULOS),
    );

    const original = BlingClient.TEMPO_LIMITE_OPERACAO_MS;
    const ajustarPrazo = (ms: number) =>
      Object.defineProperty(BlingClient, 'TEMPO_LIMITE_OPERACAO_MS', { value: ms, configurable: true });

    try {
      ajustarPrazo(20_000);
      const a = cliente.obterSituacoesDePedidoDeVenda();
      await new Promise((r) => setImmediate(r));

      ajustarPrazo(150);
      const b = cliente.obterSituacoesDePedidoDeVenda();
      await new Promise((r) => setImmediate(r));

      ajustarPrazo(20_000);
      const c = cliente.obterSituacoesDePedidoDeVenda();

      const [resultadoA] = await Promise.all([a, b, c]);
      expect(resultadoA._tag).toBe('BlingOk');

      expect(fake.recebidas.length).toBeGreaterThanOrEqual(2);
      const [primeira, segunda] = fake.recebidas;
      if (!primeira || !segunda) throw new Error('esperava duas requisições');
      expect(segunda.em).toBeGreaterThanOrEqual(primeira.em);
      expect(fake.abortadas).not.toContain(0);
    } finally {
      ajustarPrazo(original);
    }
  });

  it('quem desiste antes da vez não empurra a janela do próximo', async () => {
    // `lastRequestTime` só avança quando a vez é efetivamente usada. Se uma
    // chamada expirada o alterasse, ela empurraria o intervalo da requisição
    // seguinte sem ter feito requisição nenhuma.
    const cliente = adapter(async () => {
      await new Promise((r) => setTimeout(r, 500));
      return 'token-de-teste';
    });

    const original = BlingClient.TEMPO_LIMITE_OPERACAO_MS;
    Object.defineProperty(BlingClient, 'TEMPO_LIMITE_OPERACAO_MS', { value: 80, configurable: true });

    try {
      const expirada = await cliente.obterSituacoesDePedidoDeVenda();
      expect(expirada._tag).toBe('BlingFailed');
      // Nem chegou a requisitar: morreu na leitura do token.
      expect(fake.recebidas).toHaveLength(0);
    } finally {
      Object.defineProperty(BlingClient, 'TEMPO_LIMITE_OPERACAO_MS', { value: original, configurable: true });
    }
  });
});

describe('o prazo alcança o token e o backoff', () => {
  it('não inicia a renovação de um token já vencido depois do prazo', async () => {
    // Caminho inicial de token expirado: `getAccessToken` decide renovar antes
    // de qualquer requisição. Começar uma renovação já fora do prazo é o pior
    // gasto possível — ela faz polling de lock com `await` de banco.
    let renovacoes = 0;
    const cliente = adapter(async () => {
      await new Promise((r) => setTimeout(r, 400));
      renovacoes += 1;
      return 'token-renovado';
    });

    const original = BlingClient.TEMPO_LIMITE_OPERACAO_MS;
    Object.defineProperty(BlingClient, 'TEMPO_LIMITE_OPERACAO_MS', { value: 60, configurable: true });

    try {
      const resultado = await cliente.obterSituacoesDePedidoDeVenda();
      expect(resultado._tag).toBe('BlingFailed');
      expect(fake.recebidas).toHaveLength(0);
      // A leitura já em voo termina — é o resíduo conhecido —, mas nenhuma
      // requisição sai depois dela.
      expect(renovacoes).toBeLessThanOrEqual(1);
    } finally {
      Object.defineProperty(BlingClient, 'TEMPO_LIMITE_OPERACAO_MS', { value: original, configurable: true });
    }
  });

  it('o backoff de 429 é interrompido pelo prazo', async () => {
    // Sem isto, um 429 com `Retry-After` alto prenderia a chamada bem além do
    // orçamento — dormindo, sem nada em voo para interromper.
    const cliente = adapter();
    fake.programar({ status: 429, body: '{}', headers: { 'Retry-After': '30' } });

    const original = BlingClient.TEMPO_LIMITE_OPERACAO_MS;
    Object.defineProperty(BlingClient, 'TEMPO_LIMITE_OPERACAO_MS', { value: 400, configurable: true });

    try {
      const comecou = Date.now();
      const resultado = await cliente.obterSituacoesDePedidoDeVenda();
      const decorrido = Date.now() - comecou;

      expect(resultado._tag).toBe('BlingFailed');
      // 30 s de `Retry-After` contra 400 ms de orçamento.
      expect(decorrido).toBeLessThan(3000);
      expect(fake.recebidas).toHaveLength(1);
    } finally {
      Object.defineProperty(BlingClient, 'TEMPO_LIMITE_OPERACAO_MS', { value: original, configurable: true });
    }
  });
});

describe('o corpo de uma resposta recusada não é lido', () => {
  it('um corpo enorme não é consumido para ser descartado', async () => {
    // `falhaPublicaDoBling` cancela o fluxo em vez de fazer `text()`. Além do
    // desperdício, aquele `await` podia falhar sozinho — corpo truncado,
    // conexão caída — e mascarar um status HTTP já conhecido.
    const cliente = adapter();
    const corpoEnorme = 'x'.repeat(2_000_000);
    fake.programar({ status: 500, body: corpoEnorme });

    const resultado = await cliente.obterSituacoesDePedidoDeVenda();

    if (resultado._tag !== 'BlingFailed') throw new Error('esperava falha');
    // O status sobrevive inteiro, que é o ponto: ele já era conhecido antes de
    // o corpo existir.
    expect(resultado.failure.status).toBe(500);
    expect(resultado.failure.message).toMatch(/indisponível/iu);
    expect(resultado.failure.message).not.toMatch(/x{100}/u);
  });
});
