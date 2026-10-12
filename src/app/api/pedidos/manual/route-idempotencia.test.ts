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
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  { estado: string; blingPedidoId: string | null; pedidoId: string | null; fingerprint: string; epoca: number }
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
/** 6ª rodada — falha TIPADA da criação (status/type), para os casos ambíguos. */
let criarPedidoFalha: { status: number; type: string } | null = null;

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

        // 7ª rodada — espelha o índice único PARCIAL da migration 59: enquanto
        // existir uma tentativa sem desfecho para este fingerprint, nenhuma
        // OUTRA referência pode ser aberta para a mesma venda.
        if (!existente) {
          for (const [outraReferencia, outra] of tentativasPorReferencia) {
            if (outra.fingerprint === fingerprint && (outra.estado === 'em_andamento' || outra.estado === 'indeterminada')) {
              return Promise.resolve({
                data: [{
                  tentativa_id: null,
                  estado: null,
                  pedido_id: null,
                  bling_pedido_id: null,
                  is_duplicate: false,
                  fingerprint_conflitante: false,
                  valores_divergentes: false,
                  epoca: null,
                  referencia_pendente: outraReferencia,
                }],
                error: null,
              });
            }
          }
        }
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
                epoca: null,
              }],
              error: null,
            });
          }
          // Espelha a migration 59: uma tentativa que FALHOU definitivamente
          // (nada pendente no Bling) é reaberta pela reivindicação seguinte
          // com o MESMO conteúdo, em vez de ficar bloqueada para sempre.
          if (existente.estado === 'falhou') {
            existente.estado = 'em_andamento';
            existente.pedidoId = null;
            existente.blingPedidoId = null;
            // Reabrir avanca a epoca, como a migration 59 faz.
            existente.epoca += 1;
            return Promise.resolve({
              data: [{
                tentativa_id: `tentativa-${referencia}`,
                estado: 'em_andamento',
                pedido_id: null,
                bling_pedido_id: null,
                is_duplicate: false,
                fingerprint_conflitante: false,
                epoca: existente.epoca,
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
              epoca: existente.epoca,
            }],
            error: null,
          });
        }
        tentativasPorReferencia.set(referencia, {
          estado: 'em_andamento', blingPedidoId: null, pedidoId: null, fingerprint, epoca: 1,
        });
        return Promise.resolve({
          data: [{
            tentativa_id: `tentativa-${referencia}`,
            estado: 'em_andamento',
            pedido_id: null,
            bling_pedido_id: null,
            is_duplicate: false,
            fingerprint_conflitante: false,
            epoca: 1,
          }],
          error: null,
        });
      }
      // 9a rodada (B2): a posse e conferida antes de cada efeito externo.
      if (fnName === 'confirmar_posse_da_tentativa') {
        const referencia = String(args?.p_tentativa_id).replace(/^tentativa-/, '');
        const existente = tentativasPorReferencia.get(referencia);
        const vigente = existente !== undefined
          && existente.estado === 'em_andamento'
          && existente.epoca === args?.p_epoca_esperada;
        return Promise.resolve({ data: vigente, error: null });
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
      // 9a rodada (B1/B4): a venda e a conclusao do ledger sao UMA transacao —
      // a RPC recusa por posse perdida (55P03) antes de qualquer efeito, e no
      // sucesso conclui a tentativa junto.
      if (fnName === 'registrar_venda_manual_com_posse') {
        // Desde a 9a rodada e ESTA a RPC que conclui o ledger no caminho feliz.
        organizacoesNoConcluir.push(args?.p_organizacao_id as string | undefined);
        const referencia = String(args?.p_tentativa_id).replace(/^tentativa-/, '');
        const existente = tentativasPorReferencia.get(referencia);
        if (!existente || existente.estado !== 'em_andamento' || existente.epoca !== args?.p_epoca_esperada) {
          return Promise.resolve({
            data: null,
            error: { message: 'Tentativa tomada por outro executor', code: '55P03' },
          });
        }
        if (modoRegistrarVenda === 'sucesso') {
          existente.estado = 'concluida';
          existente.pedidoId = 'pedido-local-concorrencia-1';
          existente.blingPedidoId = (args?.p_bling_pedido_id as string | null) ?? existente.blingPedidoId;
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
                  { id: PRODUTO_ID, nome: 'Produto Teste', codigo: null, bling_id: '77', preco: 10, estoque: 5, estoque_reservado: 0, situacao: 'ativo' },
                  { id: PRODUTO_ID_B, nome: 'Produto Teste B', codigo: null, bling_id: '78', preco: 20, estoque: 5, estoque_reservado: 0, situacao: 'ativo' },
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
        if (criarPedidoFalha) {
          return Promise.resolve({
            _tag: 'BlingFailed',
            failure: {
              _tag: 'BlingProviderFailure',
              type: criarPedidoFalha.type,
              status: criarPedidoFalha.status,
              message: 'falha simulada da criação',
              duplicateSale: false,
            },
          });
        }
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

describe('POST /api/pedidos/manual — idempotência de ponta a ponta (rota real)', () => {
  beforeEach(() => {
    tentativasPorReferencia.clear();
    organizacoesNoConcluir.length = 0;
    chamadasDeCriarPedido = 0;
    modoRegistrarVenda = 'ambiguo';
    criarPedidoLanca = null;
    criarPedidoFalha = null;
  });

  // Este teste e o de concorrência abaixo atravessam a janela de confirmação
  // REAL (0/400/800/1600ms ≈ 2,8s). A versão anterior usava relógio falso para
  // pular essa espera, com um laço que avançava o tempo em fatias — e isso
  // ERA FRÁGIL: o laço tinha um teto de iterações, e quando a máquina estava
  // carregada (a CI, por exemplo) a promessa ainda não tinha resolvido ao fim
  // dele; o `await` seguinte então esperava para sempre, porque ninguém mais
  // avançava o relógio. Passava aqui e estourava 15s na CI.
  //
  // Esperar 2,8s de verdade é lento e determinístico. A troca vale: o que se
  // prova aqui é comportamento sob ambiguidade, não velocidade.
  it('ambiguidade nunca resolvida: a ROTA devolve estadoIndeterminado, e a retentativa com a MESMA referência não chama o Bling de novo', async () => {
    const { POST } = await import('./route');

    // Primeira chamada: dispara a janela de confirmação real (0/400/800/1600ms).
    const respostaPrimeira = await POST(requisicao());
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
  }, 30000);

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
    const primeira = await POST(requisicao({ referenciaLocal: referencia }));
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
  it.each([
    ['429 — a 5ª rodada reabria a chave aqui; a 6ª bloqueia', { status: 429, type: 'TOO_MANY_REQUESTS' }],
    ['4xx com type desconhecido', { status: 400, type: 'ALGUM_TIPO_NOVO' }],
    ['408', { status: 408, type: 'HTTP_408' }],
    ['502', { status: 502, type: 'HTTP_502' }],
    ['2xx com id ilegível', { status: 201, type: 'INVALID_RESPONSE' }],
  ])(
    '6ª rodada — falha ambígua da criação (%s): a retentativa com a MESMA referência não chama o Bling de novo',
    async (_descricao, falhaDaCriacao) => {
      modoRegistrarVenda = 'sucesso';
      criarPedidoFalha = falhaDaCriacao;
      const referencia = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      const { POST } = await import('./route');

      const primeira = await POST(requisicao({ referenciaLocal: referencia }));
      const corpoPrimeira = await primeira.json();

      expect(corpoPrimeira.estadoIndeterminado).toBe(true);
      expect(chamadasDeCriarPedido).toBe(1);
      expect(tentativasPorReferencia.get(`ORBITA-${referencia}`)?.estado).toBe('indeterminada');

      // Mesmo com o Bling voltando ao normal, a chave continua bloqueada.
      criarPedidoFalha = null;
      const segunda = await POST(requisicao({ referenciaLocal: referencia }));
      const corpoSegunda = await segunda.json();

      expect(corpoSegunda.estadoIndeterminado).toBe(true);
      expect(chamadasDeCriarPedido).toBe(1);
    },
  );

  it('6ª rodada — uma recusa PROVADA pelo contrato (VALIDATION_ERROR 400) reabre a chave: retentar é seguro', async () => {
    modoRegistrarVenda = 'sucesso';
    criarPedidoFalha = { status: 400, type: 'VALIDATION_ERROR' };
    const referencia = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const { POST } = await import('./route');

    const primeira = await POST(requisicao({ referenciaLocal: referencia }));
    expect(primeira.status).toBe(400);
    expect(tentativasPorReferencia.get(`ORBITA-${referencia}`)?.estado).toBe('falhou');

    // Corrigido o motivo da recusa, a MESMA referência pode ser reusada — é a
    // contrapartida de não bloquear o que comprovadamente não teve efeito.
    criarPedidoFalha = null;
    const segunda = await POST(requisicao({ referenciaLocal: referencia }));

    expect(segunda.status).toBe(201);
    expect(chamadasDeCriarPedido).toBe(2);
  });
  it('7ª rodada — DUAS requisições SIMULTÂNEAS, mesma venda e referências DIFERENTES: uma única chamada ao Bling', async () => {
    // A regressão que a revisão pediu. A guarda da 6ª rodada (inserir,
    // consultar, apagar) passava neste teste por acidente quando as chamadas
    // eram sequenciais, e falhava sob concorrência real — porque em READ
    // COMMITTED cada transação não enxerga a linha não commitada da outra.
    // A prova de banco está em `scripts/database-concurrency-pendencia.mjs`;
    // aqui prova-se que a ROTA usa essa exclusão corretamente.
    // Modo AMBÍGUO de propósito: é o que deixa a primeira tentativa
    // IRRESOLVIDA (`indeterminada`), que é a condição sob a qual o invariante
    // vale. Com a primeira já concluída, uma segunda venda idêntica é
    // legítima — e o teste seguinte prova justamente isso.
    modoRegistrarVenda = 'ambiguo';
    const { POST } = await import('./route');

    const [respostaA, respostaB] = await Promise.all([
      POST(requisicao({ referenciaLocal: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' })),
      POST(requisicao({ referenciaLocal: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' })),
    ]);
    const [corpoA, corpoB] = await Promise.all([respostaA.json(), respostaB.json()]);

    const respostas = [
      { status: respostaA.status, corpo: corpoA },
      { status: respostaB.status, corpo: corpoB },
    ];
    // A vencedora segue o fluxo (e acaba indeterminada, 500); a perdedora é
    // recusada no portão, antes de qualquer chamada ao ERP.
    const recusadas = respostas.filter((r) => r.status === 409);

    expect(recusadas).toHaveLength(1);
    // O invariante: a segunda venda idêntica NÃO chega ao Bling enquanto a
    // primeira estiver irresolvida.
    expect(chamadasDeCriarPedido).toBe(1);
    expect(recusadas[0].corpo.error).toContain('venda igual a esta');
  }, 30000);

  it('7ª rodada — resolvida a pendência, uma segunda venda legitimamente idêntica volta a ser possível', async () => {
    modoRegistrarVenda = 'sucesso';
    const { POST } = await import('./route');

    // Primeira venda: conclui normalmente (sai do índice de pendência).
    const primeira = await POST(requisicao({ referenciaLocal: 'f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1' }));
    expect(primeira.status).toBe(201);

    // Segunda venda IDÊNTICA, referência nova: numa loja física, vender duas
    // vezes a mesma coisa é rotina, e tem de continuar possível.
    const segunda = await POST(requisicao({ referenciaLocal: 'f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2f2' }));
    expect(segunda.status).toBe(201);
    expect(chamadasDeCriarPedido).toBe(2);
  });
});
