/**
 * Ticket 30, fatia 3, 3ª rodada — a regressão pedida explicitamente:
 * "atravesse a regressão até a rota". `manual-order.test.ts` prova o
 * `handler.ts` com um `ManualOrderStorePort` fake; este arquivo prova a rota
 * REAL (`route.ts`'s `POST`), com o classificador REAL
 * (`classificarErroDePersistencia`) e as RPCs REAIS de idempotência
 * (`reivindicar_tentativa_venda_manual`/`concluir_tentativa_venda_manual`),
 * só com `supabaseServer` e o cliente do Bling dublados.
 *
 * Dois fatos, provados de ponta a ponta:
 *
 *   1. Uma falha de transporte (sem `error.code`) que a janela de
 *      confirmação nunca resolve devolve exatamente
 *      `{ status: 500, estadoIndeterminado: true }` pela ROTA — não só pelo
 *      handler isolado.
 *   2. Reenviar a MESMA requisição (mesmo corpo, mesma `referenciaLocal`)
 *      depois desse estado NÃO chama `POST /pedidos/vendas` no Bling uma
 *      segunda vez — a proteção contra duplicação externa funciona com a
 *      RPC real de reivindicação, não só com a porta fake do handler.
 *   3. (4ª rodada de revisão) DUAS requisições HTTP com a MESMA
 *      `referenciaLocal`, disparadas ao mesmo tempo — `Promise.all`, sem
 *      `await` sequencial entre elas — nunca produzem duas chamadas a
 *      `createPedidoVenda`. Exatamente uma reivindica a tentativa de
 *      verdade; a outra observa `TentativaEmAndamento` e nem chega perto do
 *      Bling. A prova de atomicidade da PRÓPRIA RPC (bloqueio real via
 *      `pg_stat_activity`) está em
 *      `scripts/database-concurrency-tentativas.mjs`; este teste prova que
 *      a ROTA usa essa atomicidade corretamente — não é a mesma prova,
 *      complementa ela.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project-ref.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'public-key-12345678901234567890';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'server-key-12345678901234567890';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR_ID = '22222222-2222-4222-8222-222222222222';
const CLIENTE_ID = '33333333-3333-4333-8333-333333333333';
const PRODUTO_ID = '44444444-4444-4444-8444-444444444444';
/** Segundo produto — só para provar que a ORDEM dos itens não muda o fingerprint. */
const PRODUTO_ID_B = '4b4b4b4b-4b4b-4b4b-8b4b-4b4b4b4b4b4b';
const REFERENCIA_LOCAL = '55555555-5555-4555-8555-555555555555';

vi.mock('@/lib/requestOrganizationContext', () => ({
  resolveVerifiedOrganizationScope: vi.fn().mockResolvedValue({
    _tag: 'RequestScopeResolved',
    scope: { organizationId: ORG_ID, actorId: ACTOR_ID, role: 'owner' },
  }),
}));

/**
 * Estado das "tabelas" de tentativas, uma por `referenciaLocal` — indexado
 * por referência para que o teste de concorrência (que usa uma referência
 * própria) não interfira com o teste de ambiguidade.
 */
const tentativasPorReferencia = new Map<
  string,
  { estado: string; blingPedidoId: string | null; pedidoId: string | null; fingerprint: string }
>();
/** Organizações que o código pediu para concluir — prova que o escopo chega à RPC (5ª rodada). */
const organizacoesNoConcluir: Array<string | undefined> = [];
let chamadasDeCriarPedido = 0;
/** Controla o desfecho de `registrar_venda_manual` — ambíguo (padrão) ou sucesso, por teste. */
let modoRegistrarVenda: 'ambiguo' | 'sucesso' = 'ambiguo';
/**
 * 5ª rodada — quando definido, `criarPedidoVenda` LANÇA (timeout/conexão
 * perdida). O pedido pode ter sido criado no Bling assim mesmo: é o cenário do
 * ACK perdido na PRÓPRIA criação.
 */
let criarPedidoLanca: Error | null = null;

vi.mock('@/lib/supabaseServer', () => ({
  supabaseServer: {
    rpc: (fnName: string, args?: Record<string, unknown>) => {
      if (fnName === 'reivindicar_tentativa_venda_manual') {
        const referencia = String(args?.p_referencia_local);
        // Reivindicação ATÔMICA no nível do mock: nenhum `await` entre a
        // checagem e a gravação, exatamente como o `INSERT ... ON CONFLICT
        // DO NOTHING` real (migration 59) — uma promise síncrona resolve por
        // completo antes de ceder ao event loop, então duas chamadas
        // concorrentes (Promise.all, sem sequenciar) ainda são decididas
        // pela ORDEM REAL em que o código de cada requisição chega aqui, não
        // por uma corrida de fato dentro do mock.
        const fingerprint = String(args?.p_fingerprint ?? '');
        const existente = tentativasPorReferencia.get(referencia);
        if (existente) {
          // Espelha a migration 59: conteúdo diferente na mesma chave é
          // CONFLITO, e o desfecho da outra operação não sai daqui.
          if (existente.fingerprint !== fingerprint) {
            return Promise.resolve({
              data: [{
                tentativa_id: null,
                estado: null,
                pedido_id: null,
                bling_pedido_id: null,
                is_duplicate: true,
                fingerprint_conflitante: true,
              }],
              error: null,
            });
          }
          return Promise.resolve({
            data: [{
              tentativa_id: `tentativa-${referencia}`,
              estado: existente.estado,
              pedido_id: existente.pedidoId,
              bling_pedido_id: existente.blingPedidoId,
              is_duplicate: true,
              fingerprint_conflitante: false,
            }],
            error: null,
          });
        }
        tentativasPorReferencia.set(referencia, { estado: 'em_andamento', blingPedidoId: null, pedidoId: null, fingerprint });
        return Promise.resolve({
          data: [{
            tentativa_id: `tentativa-${referencia}`,
            estado: 'em_andamento',
            pedido_id: null,
            bling_pedido_id: null,
            is_duplicate: false,
            fingerprint_conflitante: false,
          }],
          error: null,
        });
      }
      if (fnName === 'concluir_tentativa_venda_manual') {
        organizacoesNoConcluir.push(args?.p_organizacao_id as string | undefined);
        const tentativaId = String(args?.p_tentativa_id);
        const referencia = tentativaId.replace(/^tentativa-/, '');
        const existente = tentativasPorReferencia.get(referencia);
        if (existente) {
          existente.estado = String(args?.p_estado);
          existente.blingPedidoId = (args?.p_bling_pedido_id as string | null) ?? existente.blingPedidoId;
          existente.pedidoId = (args?.p_pedido_id as string | null) ?? existente.pedidoId;
        }
        return Promise.resolve({ data: null, error: null });
      }
      if (fnName === 'registrar_venda_manual') {
        if (modoRegistrarVenda === 'sucesso') {
          return Promise.resolve({ data: 'pedido-local-concorrencia-1', error: null });
        }
        // Falha de TRANSPORTE — sem `code` — exatamente o formato que
        // `classificarErroDePersistencia` reconhece como Ambígua.
        return Promise.resolve({ data: null, error: { message: 'AbortError: The operation was aborted', code: '' } });
      }
      return Promise.resolve({ data: null, error: null });
    },
    from: (table: string) => {
      if (table === 'clientes') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: () => Promise.resolve({
                  data: { id: CLIENTE_ID, nome: 'Cliente Teste', bling_id: '999', email: null, telefone: null, cpf_cnpj: null },
                  error: null,
                }),
              }),
            }),
          }),
        };
      }
      if (table === 'produtos') {
        return {
          select: () => ({
            eq: () => ({
              in: () => Promise.resolve({
                data: [
                  { id: PRODUTO_ID, nome: 'Produto Teste', codigo: null, bling_id: '77', preco: 10, estoque: 5, estoque_reservado: 0 },
                  { id: PRODUTO_ID_B, nome: 'Produto Teste B', codigo: null, bling_id: '78', preco: 20, estoque: 5, estoque_reservado: 0 },
                ],
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === 'pedidos') {
        // `findVendaManualJaRegistrada` — nunca encontra: é o que torna a
        // ambiguidade NUNCA resolvida no teste 1.
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: () => Promise.resolve({ data: null, error: null }),
                }),
              }),
            }),
          }),
        };
      }
      return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) };
    },
  },
}));

vi.mock('@/services/bling', () => ({
  bling: {
    forVerifiedOrganization: () => ({
      obterFormaPagamentoPadraoId: () => Promise.resolve({ _tag: 'BlingOk', value: 12 }),
      criarContatoParaVenda: () => Promise.resolve({ _tag: 'BlingOk', value: { id: 999 } }),
      criarPedidoVenda: () => {
        chamadasDeCriarPedido += 1;
        if (criarPedidoLanca) return Promise.reject(criarPedidoLanca);
        return Promise.resolve({ _tag: 'BlingOk', value: { id: '918273', alertas: [] } });
      },
      buscarPedidoVendaPorNumeroLoja: () => Promise.resolve({ _tag: 'BlingOk', value: null }),
      lancarEstoquePedidoVenda: () => Promise.resolve({ _tag: 'BlingOk', value: undefined }),
      cancelarPedidoVenda: () => Promise.resolve({ _tag: 'BlingOk', value: undefined }),
    }),
  },
}));

function corpoValido() {
  return {
    syncBling: true,
    clienteId: CLIENTE_ID,
    itens: [{ produtoId: PRODUTO_ID, quantidade: 1 }],
    desconto: 0,
    frete: 0,
    formaPagamentoRotulo: 'Dinheiro',
    referenciaLocal: REFERENCIA_LOCAL,
  };
}

function requisicao(overrides: Partial<ReturnType<typeof corpoValido>> & Record<string, unknown> = {}) {
  return new Request('https://orbita.test/api/pedidos/manual', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...corpoValido(), ...overrides }),
  });
}

/**
 * Resolve uma promessa da rota avançando o relógio falso em FATIAS.
 *
 * A janela de confirmação usa `setTimeout` real (`dormirDeVerdade`), mas o
 * handler só chega até ela depois de operações assíncronas nativas — entre
 * elas o `crypto.subtle.digest` do fingerprint (5ª rodada) —, que não resolvem
 * numa única drenagem de microtasks. Avançar 3s de uma vez, antes de o código
 * ter registrado o `setTimeout`, passa por cima de um timer que ainda não
 * existe e a promessa nunca resolve. Fatiar o avanço dá ao código a chance de
 * alcançar cada espera.
 */
async function resolverAvancandoORelogio<T>(promessa: Promise<T>): Promise<T> {
  let pendente = true;
  const observada = promessa.finally(() => {
    pendente = false;
  });
  for (let fatia = 0; fatia < 40 && pendente; fatia += 1) {
    await vi.advanceTimersByTimeAsync(200);
  }
  return observada;
}

describe('POST /api/pedidos/manual — idempotência de ponta a ponta (rota real)', () => {
  beforeEach(() => {
    tentativasPorReferencia.clear();
    organizacoesNoConcluir.length = 0;
    chamadasDeCriarPedido = 0;
    modoRegistrarVenda = 'ambiguo';
    criarPedidoLanca = null;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('ambiguidade nunca resolvida: a ROTA devolve estadoIndeterminado, e a retentativa com a MESMA referência não chama o Bling de novo', async () => {
    const { POST } = await import('./route');

    // Primeira chamada: dispara a janela de confirmação real (0/400/800/1600ms).
    const respostaPrimeira = await resolverAvancandoORelogio(POST(requisicao()));
    const corpoPrimeira = await respostaPrimeira.json();

    expect(respostaPrimeira.status).toBe(500);
    expect(corpoPrimeira.estadoIndeterminado).toBe(true);
    expect(chamadasDeCriarPedido).toBe(1);

    // Segunda chamada: MESMO corpo, MESMA referenciaLocal — como um retry de
    // proxy/browser reenviaria. `reivindicar_tentativa_venda_manual` agora
    // encontra a tentativa 'indeterminada' registrada pela primeira chamada.
    const respostaSegunda = await POST(requisicao());
    const corpoSegunda = await respostaSegunda.json();

    expect(respostaSegunda.status).toBe(500);
    expect(corpoSegunda.estadoIndeterminado).toBe(true);
    // O ponto inteiro do teste: NENHUMA segunda chamada a criarPedidoVenda.
    expect(chamadasDeCriarPedido).toBe(1);
  });

  it('4ª rodada — DUAS requisições HTTP SIMULTÂNEAS com a MESMA referenciaLocal: uma única chamada ao Bling', async () => {
    modoRegistrarVenda = 'sucesso';
    const referenciaConcorrente = '66666666-6666-4666-8666-666666666666';
    const { POST } = await import('./route');

    // Disparadas com Promise.all — SEM await sequencial entre elas. É a
    // rota REAL, ponta a ponta, decidindo com a RPC real de reivindicação —
    // não uma simulação de handler com porta fake.
    const [respostaA, respostaB] = await Promise.all([
      POST(requisicao({ referenciaLocal: referenciaConcorrente })),
      POST(requisicao({ referenciaLocal: referenciaConcorrente })),
    ]);
    const [corpoA, corpoB] = await Promise.all([respostaA.json(), respostaB.json()]);

    const respostas = [
      { status: respostaA.status, corpo: corpoA },
      { status: respostaB.status, corpo: corpoB },
    ];
    const vencedoras = respostas.filter((r) => r.status === 201);
    // A PERDEDORA tem dois desfechos SEGUROS, e qual deles acontece depende do
    // entrelaçamento: se ela reivindica enquanto a vencedora ainda executa, vê
    // `em_andamento` (409); se reivindica depois que a vencedora concluiu, vê
    // o resultado pronto e o REUTILIZA (200). Fixar um dos dois seria fixar um
    // acidente de agendamento — o invariante que importa é que ela NUNCA cria
    // um segundo pedido, e que quando devolve resultado é o MESMO pedido.
    const perdedoras = respostas.filter((r) => r.status === 409 || r.status === 200);

    expect(vencedoras).toHaveLength(1);
    expect(perdedoras).toHaveLength(1);
    // O ponto central: uma única criação no Bling, sob duas requisições
    // genuinamente simultâneas com a mesma referência.
    expect(chamadasDeCriarPedido).toBe(1);
    expect(vencedoras[0].corpo.pedidoId).toBe('pedido-local-concorrencia-1');
    if (perdedoras[0].status === 200) {
      expect(perdedoras[0].corpo.pedidoId).toBe('pedido-local-concorrencia-1');
    }

    // E o desfecho posterior reutiliza o resultado correto — uma terceira
    // chamada com a MESMA referência, depois que a vencedora já concluiu,
    // encontra 'concluida' e não chama o Bling uma terceira vez.
    const respostaPosterior = await POST(requisicao({ referenciaLocal: referenciaConcorrente }));
    const corpoPosterior = await respostaPosterior.json();
    expect(respostaPosterior.status).toBe(200);
    expect(corpoPosterior.pedidoId).toBe('pedido-local-concorrencia-1');
    expect(chamadasDeCriarPedido).toBe(1);
  });
  // ==========================================================================
  // 5ª rodada de revisão
  // ==========================================================================

  it('MESMA referência + venda DIFERENTE: 409 de conflito, e NENHUMA chamada ao Bling', async () => {
    modoRegistrarVenda = 'sucesso';
    const referencia = '77777777-7777-4777-8777-777777777777';
    const { POST } = await import('./route');

    // Primeira venda: 1 unidade. Conclui normalmente.
    const primeira = await POST(requisicao({ referenciaLocal: referencia }));
    expect(primeira.status).toBe(201);
    expect(chamadasDeCriarPedido).toBe(1);

    // O usuário muda a QUANTIDADE e reenvia com a MESMA referência — o cenário
    // exato da revisão (indeterminado → reload → altera → reenvia).
    const segunda = await POST(
      requisicao({ referenciaLocal: referencia, itens: [{ produtoId: PRODUTO_ID, quantidade: 2 }] }),
    );
    const corpoSegunda = await segunda.json();

    expect(segunda.status).toBe(409);
    // NÃO devolve o resultado da primeira: dizer "já registrada" aqui seria
    // afirmar que a venda de 2 unidades existe, e ela nunca existiu.
    expect(corpoSegunda.success).toBe(false);
    expect(corpoSegunda.pedidoId).toBeUndefined();
    // E, sobretudo: não executou nada de novo no ERP.
    expect(chamadasDeCriarPedido).toBe(1);
    // A MENSAGEM tem de ser a do conflito de conteúdo, não a de "outra
    // requisição em andamento". Sem esta asserção o teste passaria mesmo com a
    // tradução do conflito removida da rota: a RPC devolve os campos nulos num
    // conflito, e o código cairia por acidente no ramo `TentativaEmAndamento`,
    // que também é 409. O bloqueio de fato vive na migration 59 (provado em
    // `tentativas_venda_manual_idempotentes.test.sql`, asserções 8-15 e 23-24);
    // o que se prova AQUI é que a rota reconhece o conflito e diz a verdade
    // sobre ele a quem está na tela.
    expect(corpoSegunda.error).toContain('referência de uma venda diferente');
  });

  it('MESMA referência + MESMA venda com os itens em outra ORDEM: é retentativa, não conflito', async () => {
    modoRegistrarVenda = 'sucesso';
    const referencia = '88888888-8888-4888-8888-888888888888';
    const { POST } = await import('./route');

    const itensA = [{ produtoId: PRODUTO_ID, quantidade: 1 }, { produtoId: PRODUTO_ID_B, quantidade: 2 }];
    const itensB = [{ produtoId: PRODUTO_ID_B, quantidade: 2 }, { produtoId: PRODUTO_ID, quantidade: 1 }];

    const primeira = await POST(requisicao({ referenciaLocal: referencia, itens: itensA }));
    expect(primeira.status).toBe(201);

    const segunda = await POST(requisicao({ referenciaLocal: referencia, itens: itensB }));
    const corpoSegunda = await segunda.json();

    // A ordem na tela não é intenção comercial: reconhece como a MESMA venda e
    // reutiliza o resultado, em vez de recusar por conflito.
    expect(segunda.status).toBe(200);
    expect(corpoSegunda.pedidoId).toBe('pedido-local-concorrencia-1');
    expect(chamadasDeCriarPedido).toBe(1);
  });

  it('ACK PERDIDO na própria criação do Bling: fica indeterminada e a retentativa NÃO cria um segundo pedido', async () => {
    modoRegistrarVenda = 'sucesso';
    criarPedidoLanca = new Error('ETIMEDOUT: socket hang up');
    const referencia = '99999999-9999-4999-8999-999999999999';
    const { POST } = await import('./route');

    // O pedido PODE ter sido criado no Bling — a resposta é que não chegou.
    const primeira = await resolverAvancandoORelogio(POST(requisicao({ referenciaLocal: referencia })));
    const corpoPrimeira = await primeira.json();

    expect(primeira.status).toBe(500);
    expect(corpoPrimeira.estadoIndeterminado).toBe(true);
    // Não inventa um bling_id que nunca chegou.
    expect(corpoPrimeira.blingPedidoId).toBeNull();
    expect(chamadasDeCriarPedido).toBe(1);

    // A tentativa NÃO pode ter ficado 'falhou' (reabrível): "não recebi
    // resposta" não é "não criou".
    // A chave do ledger é a referência que a rota monta (`ORBITA-<uuid>`) — a
    // MESMA que viaja ao Bling em `numeroLoja`, e é por isso que a
    // reconciliação consegue procurar por ela depois.
    expect(tentativasPorReferencia.get(`ORBITA-${referencia}`)?.estado).toBe('indeterminada');

    // A retentativa — agora com o Bling respondendo normalmente — continua
    // barrada. É o ponto inteiro: sem isto, ela criaria o SEGUNDO pedido.
    criarPedidoLanca = null;
    const segunda = await POST(requisicao({ referenciaLocal: referencia }));
    const corpoSegunda = await segunda.json();

    expect(corpoSegunda.estadoIndeterminado).toBe(true);
    expect(chamadasDeCriarPedido).toBe(1);
  });

  it('a organização que chega às RPCs é a do escopo verificado, não algo vindo do corpo', async () => {
    modoRegistrarVenda = 'sucesso';
    const referencia = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const { POST } = await import('./route');

    // O corpo tenta ditar a organização. O schema nem tem esse campo, e o
    // escopo vem de `resolveVerifiedOrganizationScope` — mas a asserção fixa o
    // comportamento em vez de confiar na ausência do campo.
    const resposta = await POST(
      requisicao({ referenciaLocal: referencia, organizacaoId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }),
    );

    expect(resposta.status).toBe(201);
    expect(organizacoesNoConcluir.length).toBeGreaterThan(0);
    for (const organizacao of organizacoesNoConcluir) {
      expect(organizacao).toBe(ORG_ID);
    }
  });
});
