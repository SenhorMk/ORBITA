import { NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import type { Pedido } from '@/types';
import type { EventoComercial } from '@/services/auditoriaComercial';

import { createPedidoStatusHandler } from './handler';
import type {
  PedidoStatusAuthPort,
  PedidoStatusBlingPort,
  PedidoStatusDependencies,
  PedidoStatusProduto,
  PedidoStatusStorePort,
} from './ports';

/**
 * Testes da mudança de situação do pedido.
 *
 * Esta era a única rota de escrita sem teste, e não por desleixo: ela misturava
 * fiação do Next com a regra, e nessa forma não havia como exercitá-la sem
 * subir servidor. Com as portas por parâmetro, cada caso abaixo roda em
 * milissegundos e sem tocar em HTTP, banco ou na conta real do Bling.
 */

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ATOR = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const PEDIDO_ID = '44444444-4444-4444-8444-444444444444';

const escopo = {
  organizationId: ORG_A,
  actorId: ATOR,
  role: 'owner',
} as unknown as VerifiedOrganizationScope;

const PEDIDO: Pedido = {
  id: PEDIDO_ID,
  bling_id: '26735988980',
  numero: '4321',
  data: '2026-08-31',
  total: 250,
  status: 'Pendente',
  cliente_id: '55555555-5555-4555-8555-555555555555',
};

function corpo(body: unknown): Request {
  return new Request('https://orbita.test/api/pedidos/status', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** Portas dubladas com o caminho feliz; cada teste sobrescreve só o que exercita. */
function montarDeps(sobrescritas: {
  store?: Partial<PedidoStatusStorePort>;
  bling?: Partial<PedidoStatusBlingPort>;
  auth?: Partial<PedidoStatusAuthPort>;
} = {}) {
  const updateSituacaoPedido = vi.fn<PedidoStatusBlingPort['updateSituacaoPedido']>().mockResolvedValue({ _tag: 'BlingOk', value: undefined });
  const savePedidoStatus = vi.fn<PedidoStatusStorePort['savePedidoStatus']>().mockResolvedValue(undefined);
  const alinharEstoque = vi.fn<PedidoStatusStorePort['alinharEstoque']>().mockResolvedValue('alinhado');
  const eventos: EventoComercial[] = [];
  const aguardarProcessamentoBling = vi.fn().mockResolvedValue(undefined);

  const store: PedidoStatusStorePort = {
    findPedidoById: vi.fn().mockResolvedValue(PEDIDO),
    savePedidoStatus,
    findProdutoIdsDoPedido: vi.fn().mockResolvedValue([]),
    findItensDoPedido: vi.fn().mockResolvedValue([]),
    findProdutosByIds: vi.fn().mockResolvedValue([] as readonly PedidoStatusProduto[]),
    alinharEstoque,
    ...sobrescritas.store,
  };

  const bling: PedidoStatusBlingPort = {
    updateSituacaoPedido,
    getSaldos: vi.fn().mockResolvedValue(new Map<string, number>()),
    situacoes: vi.fn().mockResolvedValue({ _tag: 'BlingOk', value: SITUACOES_DA_CONTA }),
    estornarEstoque: vi.fn<PedidoStatusBlingPort['estornarEstoque']>().mockResolvedValue({ _tag: 'BlingOk', value: undefined }),
    ...sobrescritas.bling,
  };

  const auth: PedidoStatusAuthPort = {
    authenticate: vi.fn().mockResolvedValue({ actorId: ATOR }),
    resolveScope: vi.fn().mockResolvedValue({ _tag: 'Resolved', scope: escopo }),
    ...sobrescritas.auth,
  };

  const deps: PedidoStatusDependencies = {
    auth, store, bling, aguardarProcessamentoBling,
    async auditar(_s, evento) { eventos.push(evento); },
    correlationId: () => 'corr_status',
  };
  return { deps, store, bling, auth, updateSituacaoPedido, savePedidoStatus, alinharEstoque, aguardarProcessamentoBling, eventos };
}

/**
 * Executa o handler capturando o que ele escreve no log do servidor.
 *
 * `logStructured` emite JSON em `console.error`, entao capturar ai cobre a
 * infraestrutura real de log, e nao um dublê dela.
 */
async function comLogCapturado(fn: () => Promise<Response>): Promise<{ resposta: Response; log: string }> {
  const linhas: string[] = [];
  const espia = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    linhas.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  });
  try {
    return { resposta: await fn(), log: linhas.join('\n') };
  } finally {
    espia.mockRestore();
  }
}

const CORPO_VALIDO = { pedidoId: PEDIDO_ID, novaSituacaoId: 9, novaSituacaoNome: 'Atendido' };

/** As situações de venda desta conta, como `obterSituacoesDePedidoDeVenda` as devolve (ids por conta). */
const SITUACOES_DA_CONTA = [
  { id: 6, nome: 'Em aberto' },
  { id: 9, nome: 'Atendido' },
  { id: 12, nome: 'Cancelado' },
];

/** A resposta fixa quando o Bling confirmou e o ORBITA não gravou. */
const ESPELHO_FALHOU = {
  error: 'A situação foi alterada no Bling, mas não no ORBITA. Sincronize os pedidos para reconciliar; não repita a mudança.',
  reconciliacao: { motivo: 'espelho_local_falhou' },
};

describe('POST /api/pedidos/status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('caminho feliz', () => {
    it('atualiza no Bling primeiro e só então grava o status canônico', async () => {
      const { deps, updateSituacaoPedido, savePedidoStatus } = montarDeps();

      const resposta = await createPedidoStatusHandler(deps)(corpo(CORPO_VALIDO));

      expect(resposta.status).toBe(200);
      expect(await resposta.json()).toEqual({ success: true, status: 'Atendido', estoque: 'alinhado' });
      expect(updateSituacaoPedido).toHaveBeenCalledWith('26735988980', 9);
      expect(savePedidoStatus).toHaveBeenCalledWith(escopo, PEDIDO, 'Atendido');
    });

    it('alinha o saldo local com o do Bling só onde ele mudou', async () => {
      const produtos: readonly PedidoStatusProduto[] = [
        { id: 'prod-igual', blingId: '100', estoque: 7 },
        { id: 'prod-mudou', blingId: '200', estoque: 3 },
        { id: 'prod-sem-bling', blingId: null, estoque: 1 },
      ];
      const { deps, alinharEstoque } = montarDeps({
        store: {
          findProdutoIdsDoPedido: vi.fn().mockResolvedValue(['prod-igual', 'prod-mudou', 'prod-sem-bling']),
          findProdutosByIds: vi.fn().mockResolvedValue(produtos),
        },
        bling: { getSaldos: vi.fn().mockResolvedValue(new Map([['100', 7], ['200', 12]])) },
      });

      const resposta = await createPedidoStatusHandler(deps)(corpo(CORPO_VALIDO));

      expect(resposta.status).toBe(200);
      // Só o produto cujo saldo divergiu é gravado: escrever os três geraria
      // três UPDATEs por mudança de situação, e dois deles não mudam nada.
      expect(alinharEstoque).toHaveBeenCalledTimes(1);
      // O valor lido (3) vai junto: o banco só escreve se o estoque ainda for ele.
      expect(alinharEstoque).toHaveBeenCalledWith(escopo, 'prod-mudou', 3, 12);
    });

    it('espera o Bling processar antes de reler o saldo', async () => {
      const ordem: string[] = [];
      const { deps } = montarDeps({
        store: {
          findProdutoIdsDoPedido: vi.fn().mockResolvedValue(['p1']),
          findProdutosByIds: vi.fn().mockResolvedValue([{ id: 'p1', blingId: '100', estoque: 0 }]),
        },
        bling: {
          getSaldos: vi.fn().mockImplementation(async () => {
            ordem.push('getSaldos');
            return new Map();
          }),
        },
      });
      const depsComOrdem: PedidoStatusDependencies = {
        ...deps,
        aguardarProcessamentoBling: async () => { ordem.push('espera'); },
      };

      await createPedidoStatusHandler(depsComOrdem)(corpo(CORPO_VALIDO));

      // Ler o saldo antes da espera traria o valor antigo, e o alinhamento
      // gravaria de volta exatamente o número que queríamos corrigir.
      expect(ordem).toEqual(['espera', 'getSaldos']);
    });
  });

  describe('situação inválida é recusada antes de chegar ao Bling', () => {
    const invalidos: Array<[string, unknown]> = [
      ['id zero', { ...CORPO_VALIDO, novaSituacaoId: 0 }],
      ['id negativo', { ...CORPO_VALIDO, novaSituacaoId: -3 }],
      ['id fracionário', { ...CORPO_VALIDO, novaSituacaoId: 2.5 }],
      ['id não numérico', { ...CORPO_VALIDO, novaSituacaoId: '../../outra-rota' }],
      ['nome vazio', { ...CORPO_VALIDO, novaSituacaoNome: '   ' }],
      ['pedidoId que não é UUID', { ...CORPO_VALIDO, pedidoId: 'nao-e-uuid' }],
    ];

    it.each(invalidos)('recusa com 400: %s', async (_nome, body) => {
      const { deps, updateSituacaoPedido } = montarDeps();

      const resposta = await createPedidoStatusHandler(deps)(corpo(body));

      expect(resposta.status).toBe(400);
      expect((await resposta.json()).error).toContain('Dados inválidos');
      // O id da situação entra no CAMINHO da URL do Bling. Um valor que não
      // seja inteiro positivo não pode sequer ser tentado.
      expect(updateSituacaoPedido).not.toHaveBeenCalled();
    });

    it('recusa corpo que não é JSON', async () => {
      const { deps, updateSituacaoPedido } = montarDeps();

      const resposta = await createPedidoStatusHandler(deps)(corpo('{isto não é json'));

      expect(resposta.status).toBe(400);
      expect((await resposta.json()).error).toContain('não é um JSON válido');
      expect(updateSituacaoPedido).not.toHaveBeenCalled();
    });
  });

  describe('pedido de outra organização', () => {
    it('responde 404 e não toca no Bling', async () => {
      // O adapter lê sempre com o predicado da organização: para quem está
      // fora, o pedido simplesmente não existe.
      const { deps, updateSituacaoPedido, savePedidoStatus } = montarDeps({
        store: { findPedidoById: vi.fn().mockResolvedValue(null) },
      });

      const resposta = await createPedidoStatusHandler(deps)(corpo(CORPO_VALIDO));

      expect(resposta.status).toBe(404);
      expect(updateSituacaoPedido).not.toHaveBeenCalled();
      expect(savePedidoStatus).not.toHaveBeenCalled();
    });

    it('a leitura do pedido é feita dentro do escopo verificado, nunca por id solto', async () => {
      const findPedidoById = vi.fn().mockResolvedValue(PEDIDO);
      const { deps } = montarDeps({ store: { findPedidoById } });

      await createPedidoStatusHandler(deps)(corpo(CORPO_VALIDO));

      expect(findPedidoById).toHaveBeenCalledWith(escopo, PEDIDO_ID);
    });

    it('responde 404 quando o pedido existe mas nunca foi ao Bling', async () => {
      const { deps, updateSituacaoPedido } = montarDeps({
        store: { findPedidoById: vi.fn().mockResolvedValue({ ...PEDIDO, bling_id: null }) },
      });

      const resposta = await createPedidoStatusHandler(deps)(corpo(CORPO_VALIDO));

      expect(resposta.status).toBe(404);
      expect(updateSituacaoPedido).not.toHaveBeenCalled();
    });
  });

  describe('autorização', () => {
    it('sem sessão, 401 antes de qualquer leitura', async () => {
      const findPedidoById = vi.fn();
      const { deps } = montarDeps({
        auth: { authenticate: vi.fn().mockResolvedValue(null) },
        store: { findPedidoById },
      });

      const resposta = await createPedidoStatusHandler(deps)(corpo(CORPO_VALIDO));

      expect(resposta.status).toBe(401);
      expect(findPedidoById).not.toHaveBeenCalled();
    });

    it('escopo recusado devolve a resposta do próprio limite de autorização', async () => {
      const { deps, updateSituacaoPedido } = montarDeps({
        auth: {
          resolveScope: vi.fn().mockResolvedValue({
            _tag: 'Denied',
            response: NextResponse.json({ error: 'Organização não informada' }, { status: 403 }),
          }),
        },
      });

      const resposta = await createPedidoStatusHandler(deps)(corpo(CORPO_VALIDO));

      expect(resposta.status).toBe(403);
      expect(updateSituacaoPedido).not.toHaveBeenCalled();
    });
  });

  describe('falha do Bling é reportada com a causa — no servidor, não ao cliente', () => {
    it('recusa comprovada da situação: 400, nada gravado localmente, evento de recusa', async () => {
      const { deps, savePedidoStatus, eventos } = montarDeps({
        bling: {
          updateSituacaoPedido: vi.fn().mockResolvedValue({
            _tag: 'BlingFailed',
            failure: { _tag: 'BlingProviderFailure', type: 'VALIDATION_ERROR', status: 400, message: 'situação inexistente', duplicateSale: false },
          }),
        },
      });

      const resposta = await createPedidoStatusHandler(deps)(corpo(CORPO_VALIDO));

      expect(resposta.status).toBe(400);
      expect((await resposta.json()).error).toContain('O Bling recusou a mudança de situação');
      // O Bling é a fonte da verdade: se ele recusou, o ORBITA não pode
      // registrar uma situação que não existe lá.
      expect(savePedidoStatus).not.toHaveBeenCalled();
      expect(eventos.map((e) => e.acao)).toEqual(['order.status_change_rejected']);
    });

    it('erro do PostgREST fica legível no servidor e genérico na resposta', async () => {
      // O que o supabase-js lança não é um Error. Antes do ticket 03 o log
      // dizia "[object Object]" e o código SQL sumia; desde o ticket 04 ele
      // chegava legível — só que na resposta HTTP, que era o vazamento.
      const { deps } = montarDeps({
        store: {
          savePedidoStatus: vi.fn().mockRejectedValue({
            code: '42P10',
            message: 'there is no unique or exclusion constraint matching the ON CONFLICT specification',
          }),
        },
      });

      const { resposta, log } = await comLogCapturado(() =>
        createPedidoStatusHandler(deps)(corpo(CORPO_VALIDO)),
      );

      expect(resposta.status).toBe(500);
      expect(await resposta.json()).toEqual(ESPELHO_FALHOU);

      // A cobertura não sumiu, mudou de lado: o SQLSTATE continua investigável.
      expect(log).toContain('42P10');
      expect(log).not.toContain('[object Object]');
      // E a mensagem não vai junto, porque é onde o Postgres põe valor de linha.
      expect(log).not.toContain('ON CONFLICT');
    });

    it('falha ao ler os itens vira aviso, porque a situação já mudou nos dois lados', async () => {
      const { deps } = montarDeps({
        store: { findProdutoIdsDoPedido: vi.fn().mockRejectedValue(new Error('conexão recusada')) },
      });

      const resposta = await createPedidoStatusHandler(deps)(corpo(CORPO_VALIDO));

      // 200, e não 500: dizer "falhou" faria o chamador acreditar que a
      // situação não mudou — e ela mudou, no Bling e no ORBITA.
      expect(resposta.status).toBe(200);
      const corpoResposta = await resposta.json();
      expect(corpoResposta.success).toBe(true);
      expect(corpoResposta.estoque).toBe('requer_reconciliacao');
      expect(corpoResposta.warning).toContain('não foi conferido');
    });
  });

  describe('CWE-209: a resposta 500 não expõe diagnóstico interno', () => {
    /**
     * Erro do PostgREST com os quatro campos que o Postgres devolve. `details`
     * é o pior: numa violação de unicidade ele carrega **valores de linha**
     * ("Key (email)=(...) already exists"), quer dizer, dado de cliente.
     * Todos os valores aqui são sintéticos.
     */
    const ERRO_POSTGREST = {
      code: '42501',
      message: 'permission denied for table pedidos',
      details: 'Key (email)=(cliente-sintetico@exemplo.com) already exists.',
      hint: 'conceda SELECT ao papel service_role',
    };

    /** Marcadores que jamais podem aparecer no corpo da resposta HTTP. */
    const MARCADORES = [
      '42501',
      'permission denied',
      'cliente-sintetico@exemplo.com',
      'service_role',
      'Key (email)',
    ];

    it('erro do PostgREST não vaza code, message, details nem hint', async () => {
      const { deps } = montarDeps({
        store: { savePedidoStatus: vi.fn().mockRejectedValue(ERRO_POSTGREST) },
      });

      const resposta = await createPedidoStatusHandler(deps)(corpo(CORPO_VALIDO));

      expect(resposta.status).toBe(500);
      const json = await resposta.json();

      // Exatamente a frase fixa do desfecho parcial: nada do erro.
      expect(json).toEqual(ESPELHO_FALHOU);

      const serializado = JSON.stringify(json);
      for (const marcador of MARCADORES) {
        expect(serializado, `vazou "${marcador}" na resposta HTTP`).not.toContain(marcador);
      }
    });

    it('Error com mensagem sensível também não vaza', async () => {
      const erro = new Error(
        'falha ao gravar — Authorization: Bearer tok-sintetico-abcdefgh; Set-Cookie: sessao=valor-sintetico',
      );
      const { deps } = montarDeps({
        bling: { updateSituacaoPedido: vi.fn().mockRejectedValue(erro) },
      });

      const resposta = await createPedidoStatusHandler(deps)(corpo(CORPO_VALIDO));

      // Exceção ao falar com o Bling é desfecho desconhecido, com frase fixa.
      expect(resposta.status).toBe(502);
      const serializado = JSON.stringify(await resposta.json());
      expect(serializado).not.toContain('tok-sintetico');
      expect(serializado).not.toContain('sessao=');
    });

    it('o diagnóstico seguro fica no servidor: operação e código técnico', async () => {
      const capturado: string[] = [];
      const espia = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        capturado.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
      });

      try {
        const { deps } = montarDeps({
          store: { savePedidoStatus: vi.fn().mockRejectedValue(ERRO_POSTGREST) },
        });
        await createPedidoStatusHandler(deps)(corpo(CORPO_VALIDO));
      } finally {
        espia.mockRestore();
      }

      const log = capturado.join('\n');

      // O que serve para investigar: qual operação falhou e qual o SQLSTATE.
      expect(log).toContain('pedidos.status.atualizar');
      expect(log).toContain('42501');

      // O que não pode estar lá: mensagem, dica e, sobretudo, valores de linha.
      expect(log).not.toContain('cliente-sintetico@exemplo.com');
      expect(log).not.toContain('Key (email)');
      expect(log).not.toContain('permission denied');
      expect(log).not.toContain('service_role');
    });

    it('código técnico que não é SQLSTATE não entra no log', async () => {
      const capturado: string[] = [];
      const espia = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        capturado.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
      });

      try {
        const { deps } = montarDeps({
          store: {
            savePedidoStatus: vi.fn().mockRejectedValue({
              // `code` é texto livre vindo de fora; sem validação, ele mesmo
              // seria um canal para injetar conteúdo no log.
              code: 'Bearer tok-sintetico-abcdefgh',
              message: 'qualquer coisa',
            }),
          },
        });
        await createPedidoStatusHandler(deps)(corpo(CORPO_VALIDO));
      } finally {
        espia.mockRestore();
      }

      expect(capturado.join('\n')).not.toContain('tok-sintetico-abcdefgh');
    });
  });
});

describe('POST /api/pedidos/status — desfechos e estoque (PRE-006C)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const falhaDoBling = (type: string, status: number) => vi.fn().mockResolvedValue({
    _tag: 'BlingFailed',
    failure: { _tag: 'BlingProviderFailure', type, status, message: 'x', duplicateSale: false },
  });

  it('timeout, 429, 5xx e exceção de rede: 502 desconhecido, sem gravação local e sem sucesso inventado', async () => {
    for (const updateSituacaoPedido of [
      falhaDoBling('UNKNOWN_ERROR', 0),
      falhaDoBling('TOO_MANY_REQUESTS', 429),
      falhaDoBling('SERVER_ERROR', 503),
      falhaDoBling('INVALID_RESPONSE', 200),
      vi.fn().mockRejectedValue(new TypeError('fetch failed')),
    ]) {
      const { deps, savePedidoStatus, alinharEstoque, eventos } = montarDeps({ bling: { updateSituacaoPedido } });

      const resposta = await createPedidoStatusHandler(deps)(corpo(CORPO_VALIDO));
      const json = await resposta.json();

      expect(resposta.status).toBe(502);
      expect(json.success).toBeUndefined();
      expect(json.reconciliacao).toEqual({ motivo: 'bling_sem_confirmacao' });
      expect(savePedidoStatus).not.toHaveBeenCalled();
      expect(alinharEstoque).not.toHaveBeenCalled();
      expect(eventos.map((e) => [e.acao, e.metadata.motivo])).toEqual([['order.reconcile_required', 'bling_sem_confirmacao']]);
    }
  });

  it('Bling confirmou e a gravação local falhou: 500 parcial, nunca "repita"', async () => {
    const { deps, eventos } = montarDeps({ store: { savePedidoStatus: vi.fn().mockRejectedValue({ code: '40001' }) } });

    const resposta = await createPedidoStatusHandler(deps)(corpo(CORPO_VALIDO));

    expect(resposta.status).toBe(500);
    expect(await resposta.json()).toEqual(ESPELHO_FALHOU);
    expect(eventos.map((e) => [e.acao, e.metadata.motivo])).toEqual([['order.reconcile_required', 'espelho_local_falhou']]);
  });

  it('estoque que mudou depois da leitura (venda manual) não é sobrescrito: pendência, não sucesso completo', async () => {
    const { deps, eventos } = montarDeps({
      store: {
        findProdutoIdsDoPedido: vi.fn().mockResolvedValue(['p1', 'p2']),
        findProdutosByIds: vi.fn().mockResolvedValue([
          { id: 'p1', blingId: '100', estoque: 5 },
          { id: 'p2', blingId: '200', estoque: 2 },
        ]),
        alinharEstoque: vi.fn<PedidoStatusStorePort['alinharEstoque']>()
          .mockResolvedValueOnce('divergiu')
          .mockResolvedValueOnce('alinhado'),
      },
      bling: { getSaldos: vi.fn().mockResolvedValue(new Map([['100', 4], ['200', 1]])) },
    });

    const resposta = await createPedidoStatusHandler(deps)(corpo(CORPO_VALIDO));
    const json = await resposta.json();

    expect(resposta.status).toBe(200);
    expect(json).toMatchObject({ success: true, estoque: 'requer_reconciliacao' });
    expect(json.warning).toContain('1 produto(s)');
    expect(eventos.at(-1)).toMatchObject({
      acao: 'order.status_changed',
      metadata: { estoque: 'parcial', produtos_alinhados: 1, produtos_pendentes: 1 },
    });
  });

  it('saldo do Bling ilegível depois da mudança: aviso, não 500 — a situação já mudou', async () => {
    const { deps } = montarDeps({
      store: {
        findProdutoIdsDoPedido: vi.fn().mockResolvedValue(['p1']),
        findProdutosByIds: vi.fn().mockResolvedValue([{ id: 'p1', blingId: '100', estoque: 5 }]),
      },
      bling: { getSaldos: vi.fn().mockRejectedValue(new Error('Bling indisponível')) },
    });

    const resposta = await createPedidoStatusHandler(deps)(corpo(CORPO_VALIDO));

    expect(resposta.status).toBe(200);
    expect(await resposta.json()).toMatchObject({ success: true, estoque: 'requer_reconciliacao' });
  });

  it('retry depois do alinhamento: o banco responde "já alinhado" e nada novo é lançado', async () => {
    const { deps, eventos } = montarDeps({
      store: {
        findProdutoIdsDoPedido: vi.fn().mockResolvedValue(['p1']),
        findProdutosByIds: vi.fn().mockResolvedValue([{ id: 'p1', blingId: '100', estoque: 5 }]),
        alinharEstoque: vi.fn<PedidoStatusStorePort['alinharEstoque']>().mockResolvedValue('ja_alinhado'),
      },
      bling: { getSaldos: vi.fn().mockResolvedValue(new Map([['100', 4]])) },
    });

    const resposta = await createPedidoStatusHandler(deps)(corpo(CORPO_VALIDO));

    expect(await resposta.json()).toEqual({ success: true, status: 'Atendido', estoque: 'alinhado' });
    expect(eventos.at(-1)!.metadata).toMatchObject({ estoque: 'alinhado', produtos_alinhados: 0, produtos_pendentes: 0 });
  });

  it('o evento de sucesso tem ator e pedido, sem nada do Bling', async () => {
    const { deps, eventos } = montarDeps();

    await createPedidoStatusHandler(deps)(corpo(CORPO_VALIDO));

    expect(eventos).toEqual([{
      acao: 'order.status_changed', recurso: 'pedido', recursoId: PEDIDO_ID, correlationId: 'corr_status',
      metadata: { pedido_id: PEDIDO_ID, situacao_id: 9, estoque: 'alinhado', produtos_alinhados: 0, produtos_pendentes: 0 },
    }]);
  });
});

describe('POST /api/pedidos/status — a situação é confirmada pela conta (PRE-006C, revisão)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('id e nome que a conta confirma: muda no Bling e o status local vem do nome confirmado', async () => {
    const { deps, updateSituacaoPedido, savePedidoStatus } = montarDeps();

    const resposta = await createPedidoStatusHandler(deps)(corpo({ pedidoId: PEDIDO_ID, novaSituacaoId: 12, novaSituacaoNome: ' cancelado ' }));

    expect(resposta.status).toBe(200);
    expect(updateSituacaoPedido).toHaveBeenCalledWith('26735988980', 12);
    expect(savePedidoStatus).toHaveBeenCalledWith(escopo, PEDIDO, 'Cancelado');
  });

  it('caminho da tela de cancelamento: o par que /api/bling/situacoes publicou passa', async () => {
    const { deps, savePedidoStatus } = montarDeps();
    const cancelado = SITUACOES_DA_CONTA.find((s) => s.nome === 'Cancelado')!;

    const resposta = await createPedidoStatusHandler(deps)(corpo({ pedidoId: PEDIDO_ID, novaSituacaoId: cancelado.id, novaSituacaoNome: cancelado.nome }));

    expect(resposta.status).toBe(200);
    expect(savePedidoStatus).toHaveBeenCalledWith(escopo, PEDIDO, 'Cancelado');
  });

  it('id válido com nome adulterado: 400 antes de qualquer efeito, sem evento', async () => {
    const { deps, updateSituacaoPedido, savePedidoStatus, alinharEstoque, eventos } = montarDeps();

    // O id de "Em aberto" com o nome "Atendido": o Bling iria para um, o ORBITA para o outro.
    const resposta = await createPedidoStatusHandler(deps)(corpo({ pedidoId: PEDIDO_ID, novaSituacaoId: 6, novaSituacaoNome: 'Atendido' }));

    expect(resposta.status).toBe(400);
    expect((await resposta.json()).error).toContain('não corresponde');
    expect(updateSituacaoPedido).not.toHaveBeenCalled();
    expect(savePedidoStatus).not.toHaveBeenCalled();
    expect(alinharEstoque).not.toHaveBeenCalled();
    expect(eventos).toEqual([]);
  });

  it('id que não existe na conta (por exemplo, um código numérico de status): 400, nada alterado', async () => {
    const { deps, updateSituacaoPedido, savePedidoStatus } = montarDeps();

    const resposta = await createPedidoStatusHandler(deps)(corpo({ pedidoId: PEDIDO_ID, novaSituacaoId: 999, novaSituacaoNome: 'Atendido' }));

    expect(resposta.status).toBe(400);
    expect(updateSituacaoPedido).not.toHaveBeenCalled();
    expect(savePedidoStatus).not.toHaveBeenCalled();
  });

  it('falha ao ler as situações (tipada ou exceção): 502 sem mudança e sem situação inventada', async () => {
    for (const situacoes of [
      vi.fn().mockResolvedValue({ _tag: 'BlingFailed', failure: { _tag: 'BlingProviderFailure', type: 'SERVER_ERROR', status: 503, message: 'x', duplicateSale: false } }),
      vi.fn().mockRejectedValue(new TypeError('fetch failed')),
    ]) {
      const { deps, updateSituacaoPedido, savePedidoStatus, eventos } = montarDeps({ bling: { situacoes } });

      const resposta = await createPedidoStatusHandler(deps)(corpo(CORPO_VALIDO));
      const json = await resposta.json();

      expect(resposta.status).toBe(502);
      expect(json.error).toContain('Nada foi alterado');
      expect(json.reconciliacao).toBeUndefined();
      expect(updateSituacaoPedido).not.toHaveBeenCalled();
      expect(savePedidoStatus).not.toHaveBeenCalled();
      expect(eventos).toEqual([]);
    }
  });
});

describe('POST /api/pedidos/status — saldo não comprovado não altera estoque (PRE-006C, revisão)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const comProduto = (estoque: number) => ({
    findProdutoIdsDoPedido: vi.fn().mockResolvedValue(['p1']),
    findProdutosByIds: vi.fn().mockResolvedValue([{ id: 'p1', blingId: '100', estoque }]),
  });

  it('produto sem saldo comprovado no mapa: nenhuma RPC de alinhamento e pendência de reconciliação', async () => {
    const { deps, alinharEstoque } = montarDeps({
      store: comProduto(5),
      bling: { getSaldos: vi.fn().mockResolvedValue(new Map<string, number>()) },
    });

    const resposta = await createPedidoStatusHandler(deps)(corpo(CORPO_VALIDO));

    expect(alinharEstoque).not.toHaveBeenCalled();
    expect(await resposta.json()).toMatchObject({ success: true, estoque: 'requer_reconciliacao' });
  });

  it('saldo zero informado pelo Bling é alinhado como zero', async () => {
    const { deps, alinharEstoque } = montarDeps({
      store: comProduto(5),
      bling: { getSaldos: vi.fn().mockResolvedValue(new Map([['100', 0]])) },
    });

    await createPedidoStatusHandler(deps)(corpo(CORPO_VALIDO));

    expect(alinharEstoque).toHaveBeenCalledWith(escopo, 'p1', 5, 0);
  });
});

// Staging, 20/11/2026: o pedido de teste 27462764185 foi cancelado pelo ORBITA e o saldo continuou
// baixado no Bling e no ORBITA. Mudar a situação não estorna o estoque lançado por `lancar-estoque`.
describe('POST /api/pedidos/status — cancelamento devolve o estoque lançado', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const CANCELAR = { pedidoId: PEDIDO_ID, novaSituacaoId: 12, novaSituacaoNome: 'Cancelado' };
  /** Um item: produto p1 (Bling 100), 1 unidade vendida, ORBITA com 7. */
  const umProduto = () => ({
    findProdutoIdsDoPedido: vi.fn().mockResolvedValue(['p1']),
    findItensDoPedido: vi.fn().mockResolvedValue([{ produtoId: 'p1', quantidade: 1 }]),
    findProdutosByIds: vi.fn().mockResolvedValue([{ id: 'p1', blingId: '100', estoque: 7 }]),
  });
  /** Bling e ORBITA com o mesmo saldo: o alinhamento sozinho diria "alinhado". */
  const saldosCoincidem = () => ({ getSaldos: vi.fn().mockResolvedValue(new Map([['100', 7]])) });
  const falha = (type: string, status: number) => vi.fn().mockResolvedValue({
    _tag: 'BlingFailed',
    failure: { _tag: 'BlingProviderFailure', type, status, message: 'Estoque nao lancado para este pedido', duplicateSale: false },
  });
  const corpoDe = async (r: Response) => (await r.json()) as { estoque?: string; warning?: string; success?: boolean };
  const metadataDo = (eventos: EventoComercial[], acao: string) => eventos.find((e) => e.acao === acao)?.metadata;

  /** Saldos do Bling em sequência: antes do estorno, na conferência, no alinhamento. */
  const saldosEmSequencia = (...valores: number[]) => {
    const getSaldos = vi.fn();
    for (const v of valores) getSaldos.mockResolvedValueOnce(new Map([['100', v]]));
    return getSaldos.mockResolvedValue(new Map([['100', valores[valores.length - 1]]]));
  };

  it('lê a base antes do estorno; Bling aceitou e o saldo voltou ao esperado = estornado e alinhado', async () => {
    const ordem: string[] = [];
    const getSaldos = saldosEmSequencia(7, 8, 8);
    const { deps, bling, eventos } = montarDeps({
      bling: {
        updateSituacaoPedido: vi.fn().mockImplementation(async () => { ordem.push('situacao'); return { _tag: 'BlingOk', value: undefined }; }),
        estornarEstoque: vi.fn().mockImplementation(async () => { ordem.push('estorno'); return { _tag: 'BlingOk', value: undefined }; }),
        getSaldos: vi.fn().mockImplementation(async (ids: readonly string[]) => { ordem.push('saldo'); return getSaldos(ids); }),
      },
      store: { ...umProduto(), findProdutosByIds: vi.fn().mockResolvedValue([{ id: 'p1', blingId: '100', estoque: 8 }]) },
    });

    const resposta = await createPedidoStatusHandler(deps)(corpo(CANCELAR));

    expect(resposta.status).toBe(200);
    expect(await corpoDe(resposta)).toEqual({ success: true, status: 'Cancelado', estoque: 'alinhado' });
    expect(bling.estornarEstoque).toHaveBeenCalledWith('26735988980');
    // base (antes) → estorno → conferência → alinhamento
    expect(ordem).toEqual(['situacao', 'saldo', 'estorno', 'saldo', 'saldo']);
    expect(metadataDo(eventos, 'order.stock_reversal')).toMatchObject({ resultado: 'estornado', status_http: null, produtos_divergentes: 0 });
    expect(metadataDo(eventos, 'order.status_changed')).toMatchObject({ estorno: 'estornado' });
  });

  it('Bling aceitou, mas o saldo não voltou: divergente e explícito, mesmo com ORBITA e Bling coincidindo', async () => {
    const { deps, eventos } = montarDeps({ bling: saldosCoincidem(), store: umProduto() });

    const resposta = await createPedidoStatusHandler(deps)(corpo(CANCELAR));
    const body = await corpoDe(resposta);

    expect(resposta.status).toBe(200);
    expect(body.estoque).toBe('requer_reconciliacao');
    expect(body.warning).toContain('o saldo de 1 produto(s) não é o esperado');
    expect(body.warning).toContain('não repita o cancelamento');
    expect(metadataDo(eventos, 'order.stock_reversal')).toMatchObject({ resultado: 'divergente', produtos_divergentes: 1 });
    expect(metadataDo(eventos, 'order.status_changed')).toMatchObject({ estorno: 'divergente', estoque: 'alinhado' });
  });

  it('estorno parcial (voltou menos que o vendido) é divergente', async () => {
    const { deps } = montarDeps({
      bling: { getSaldos: saldosEmSequencia(7, 8, 8) },
      store: { ...umProduto(), findItensDoPedido: vi.fn().mockResolvedValue([{ produtoId: 'p1', quantidade: 2 }]) },
    });

    const body = await corpoDe(await createPedidoStatusHandler(deps)(corpo(CANCELAR)));

    expect(body.estoque).toBe('requer_reconciliacao');
    expect(body.warning).toContain('não é o esperado');
  });

  it('itens repetidos do mesmo produto somam na quantidade esperada', async () => {
    const { deps, eventos } = montarDeps({
      bling: { getSaldos: saldosEmSequencia(7, 10, 10) },
      store: {
        ...umProduto(),
        findItensDoPedido: vi.fn().mockResolvedValue([{ produtoId: 'p1', quantidade: 1 }, { produtoId: 'p1', quantidade: 2 }]),
      },
    });

    await createPedidoStatusHandler(deps)(corpo(CANCELAR));

    expect(metadataDo(eventos, 'order.stock_reversal')).toMatchObject({ resultado: 'estornado' });
  });

  it('sem base para conferir (saldo de antes ilegível): sem_conferencia, nunca estornado', async () => {
    const getSaldos = vi.fn().mockRejectedValueOnce(new Error('timeout')).mockResolvedValue(new Map([['100', 8]]));
    const { deps, bling, eventos } = montarDeps({ bling: { getSaldos }, store: umProduto() });

    const body = await corpoDe(await createPedidoStatusHandler(deps)(corpo(CANCELAR)));

    // A falha da base não impede o estorno: o cancelamento comercial já foi confirmado.
    expect(bling.estornarEstoque).toHaveBeenCalledTimes(1);
    expect(body.estoque).toBe('requer_reconciliacao');
    expect(body.warning).toContain('não foi possível conferir o saldo esperado');
    expect(metadataDo(eventos, 'order.stock_reversal')).toMatchObject({ resultado: 'sem_conferencia' });
  });

  it('produto do pedido sem id no Bling: sem_conferencia', async () => {
    const { deps, eventos } = montarDeps({
      bling: { getSaldos: saldosEmSequencia(7, 8, 8) },
      store: { ...umProduto(), findProdutosByIds: vi.fn().mockResolvedValue([{ id: 'p1', blingId: null, estoque: 7 }]) },
    });

    await createPedidoStatusHandler(deps)(corpo(CANCELAR));

    expect(metadataDo(eventos, 'order.stock_reversal')).toMatchObject({ resultado: 'sem_conferencia' });
  });

  it('releitura de conferência ilegível: sem_conferencia', async () => {
    const getSaldos = vi.fn()
      .mockResolvedValueOnce(new Map([['100', 7]]))
      .mockRejectedValueOnce(new Error('503'))
      .mockResolvedValue(new Map([['100', 8]]));
    const { deps, eventos } = montarDeps({ bling: { getSaldos }, store: umProduto() });

    const body = await corpoDe(await createPedidoStatusHandler(deps)(corpo(CANCELAR)));

    expect(body.estoque).toBe('requer_reconciliacao');
    expect(metadataDo(eventos, 'order.stock_reversal')).toMatchObject({ resultado: 'sem_conferencia' });
  });

  it('o saldo devolvido pelo Bling é alinhado localmente', async () => {
    const { deps, alinharEstoque } = montarDeps({
      bling: { getSaldos: vi.fn().mockResolvedValue(new Map([['100', 8]])) },
      store: umProduto(),
    });

    await createPedidoStatusHandler(deps)(corpo(CANCELAR));

    expect(alinharEstoque).toHaveBeenCalledWith(escopo, 'p1', 7, 8);
  });

  it('recusa comprovada: requer reconciliação com aviso, mesmo com os saldos coincidindo', async () => {
    const { deps, savePedidoStatus, eventos } = montarDeps({
      bling: { estornarEstoque: falha('VALIDATION_ERROR', 400), ...saldosCoincidem() },
      store: umProduto(),
    });

    const resposta = await createPedidoStatusHandler(deps)(corpo(CANCELAR));
    const body = await corpoDe(resposta);

    expect(resposta.status).toBe(200);
    expect(body.estoque).toBe('requer_reconciliacao');
    expect(body.warning).toContain('o Bling recusou o estorno do estoque');
    expect(body.warning).toContain('não repita o cancelamento');
    // A situação comercial confirmada é preservada.
    expect(savePedidoStatus).toHaveBeenCalledWith(escopo, PEDIDO, 'Cancelado');
    expect(metadataDo(eventos, 'order.stock_reversal')).toMatchObject({ resultado: 'recusado', status_http: 400 });
  });

  it('400 sem tipo de recusa comprovada não é presumido como recusa: desconhecido', async () => {
    const { deps, eventos } = montarDeps({
      bling: { estornarEstoque: falha('UNKNOWN', 400), ...saldosCoincidem() },
      store: umProduto(),
    });

    const body = await corpoDe(await createPedidoStatusHandler(deps)(corpo(CANCELAR)));

    expect(body.estoque).toBe('requer_reconciliacao');
    expect(body.warning).toContain('não confirmou o estorno');
    expect(metadataDo(eventos, 'order.stock_reversal')).toMatchObject({ resultado: 'desconhecido', status_http: 400 });
  });

  it('timeout, 429 e 5xx: desconhecido, requer reconciliação e uma única tentativa (sem retry cego)', async () => {
    for (const estornarEstoque of [falha('TIMEOUT', 0), falha('TOO_MANY_REQUESTS', 429), falha('SERVER_ERROR', 503)]) {
      const { deps, eventos } = montarDeps({ bling: { estornarEstoque, ...saldosCoincidem() }, store: umProduto() });

      const body = await corpoDe(await createPedidoStatusHandler(deps)(corpo(CANCELAR)));

      expect(body.estoque).toBe('requer_reconciliacao');
      expect(body.warning).toContain('pode ter sido aplicado');
      expect(estornarEstoque).toHaveBeenCalledTimes(1);
      expect(metadataDo(eventos, 'order.stock_reversal')).toMatchObject({ resultado: 'desconhecido' });
    }
  });

  it('exceção de rede no estorno: desconhecido, sem derrubar o cancelamento', async () => {
    const { deps } = montarDeps({
      bling: { estornarEstoque: vi.fn().mockRejectedValue(new Error('ECONNRESET')), ...saldosCoincidem() },
      store: umProduto(),
    });

    const resposta = await createPedidoStatusHandler(deps)(corpo(CANCELAR));

    expect(resposta.status).toBe(200);
    expect((await corpoDe(resposta)).estoque).toBe('requer_reconciliacao');
  });

  it('pedido que já estava cancelado: nenhum novo estorno, e o aviso diz por quê', async () => {
    const { deps, bling, eventos } = montarDeps({
      store: { ...umProduto(), findPedidoById: vi.fn().mockResolvedValue({ ...PEDIDO, status: 'Cancelado' }) },
      bling: saldosCoincidem(),
    });

    const body = await corpoDe(await createPedidoStatusHandler(deps)(corpo(CANCELAR)));

    expect(bling.estornarEstoque).not.toHaveBeenCalled();
    expect(body.warning).toContain('nenhum novo estorno');
    expect(metadataDo(eventos, 'order.stock_reversal')).toMatchObject({ resultado: 'ja_cancelado' });
  });

  it('mudar para outra situação não estorna nada', async () => {
    const { deps, bling } = montarDeps();

    await createPedidoStatusHandler(deps)(corpo(CORPO_VALIDO));

    expect(bling.estornarEstoque).not.toHaveBeenCalled();
  });

  it('o Bling recusou a situação: nenhum estorno', async () => {
    const { deps, bling } = montarDeps({ bling: { updateSituacaoPedido: falha('VALIDATION_ERROR', 400) } });

    await createPedidoStatusHandler(deps)(corpo(CANCELAR));

    expect(bling.estornarEstoque).not.toHaveBeenCalled();
  });
});
