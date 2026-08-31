import { NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import type { Pedido } from '@/types';

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
  const updateSituacaoPedido = vi.fn<PedidoStatusBlingPort['updateSituacaoPedido']>().mockResolvedValue(undefined);
  const savePedidoStatus = vi.fn<PedidoStatusStorePort['savePedidoStatus']>().mockResolvedValue(undefined);
  const updateEstoqueProduto = vi.fn<PedidoStatusStorePort['updateEstoqueProduto']>().mockResolvedValue(undefined);
  const aguardarProcessamentoBling = vi.fn().mockResolvedValue(undefined);

  const store: PedidoStatusStorePort = {
    findPedidoById: vi.fn().mockResolvedValue(PEDIDO),
    savePedidoStatus,
    findProdutoIdsDoPedido: vi.fn().mockResolvedValue([]),
    findProdutosByIds: vi.fn().mockResolvedValue([] as readonly PedidoStatusProduto[]),
    updateEstoqueProduto,
    ...sobrescritas.store,
  };

  const bling: PedidoStatusBlingPort = {
    updateSituacaoPedido,
    getSaldos: vi.fn().mockResolvedValue(new Map<string, number>()),
    ...sobrescritas.bling,
  };

  const auth: PedidoStatusAuthPort = {
    authenticate: vi.fn().mockResolvedValue({ actorId: ATOR }),
    resolveScope: vi.fn().mockResolvedValue({ _tag: 'Resolved', scope: escopo }),
    ...sobrescritas.auth,
  };

  const deps: PedidoStatusDependencies = { auth, store, bling, aguardarProcessamentoBling };
  return { deps, store, bling, auth, updateSituacaoPedido, savePedidoStatus, updateEstoqueProduto, aguardarProcessamentoBling };
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

describe('POST /api/pedidos/status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('caminho feliz', () => {
    it('atualiza no Bling primeiro e só então grava o status canônico', async () => {
      const { deps, updateSituacaoPedido, savePedidoStatus } = montarDeps();

      const resposta = await createPedidoStatusHandler(deps)(corpo(CORPO_VALIDO));

      expect(resposta.status).toBe(200);
      expect(await resposta.json()).toEqual({ success: true, status: 'Atendido' });
      expect(updateSituacaoPedido).toHaveBeenCalledWith('26735988980', 9);
      expect(savePedidoStatus).toHaveBeenCalledWith(escopo, PEDIDO, 'Atendido');
    });

    it('alinha o saldo local com o do Bling só onde ele mudou', async () => {
      const produtos: readonly PedidoStatusProduto[] = [
        { id: 'prod-igual', blingId: '100', estoque: 7 },
        { id: 'prod-mudou', blingId: '200', estoque: 3 },
        { id: 'prod-sem-bling', blingId: null, estoque: 1 },
      ];
      const { deps, updateEstoqueProduto } = montarDeps({
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
      expect(updateEstoqueProduto).toHaveBeenCalledTimes(1);
      expect(updateEstoqueProduto).toHaveBeenCalledWith(escopo, 'prod-mudou', 12);
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
    it('recusa da situação derruba a requisição e não grava nada localmente', async () => {
      const { deps, savePedidoStatus } = montarDeps({
        bling: {
          updateSituacaoPedido: vi.fn().mockRejectedValue(
            new Error('Erro na API Bling ao alterar situação do pedido (HTTP 400): situação inexistente'),
          ),
        },
      });

      const { resposta, log } = await comLogCapturado(() =>
        createPedidoStatusHandler(deps)(corpo(CORPO_VALIDO)),
      );

      expect(resposta.status).toBe(500);
      // A causa deixou de ir ao cliente (CWE-209) e passou a viver no log.
      expect(await resposta.json()).toEqual({ error: 'Erro interno' });
      expect(log).toContain('pedidos.status.atualizar');
      // O Bling é a fonte da verdade: se ele recusou, o ORBITA não pode
      // registrar uma situação que não existe lá.
      expect(savePedidoStatus).not.toHaveBeenCalled();
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
      expect(await resposta.json()).toEqual({ error: 'Erro interno' });

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
      expect(corpoResposta.warning).toContain('alinhar estoque');
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

      // Exatamente a mensagem genérica: nada além dela.
      expect(json).toEqual({ error: 'Erro interno' });

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

      expect(resposta.status).toBe(500);
      expect(await resposta.json()).toEqual({ error: 'Erro interno' });
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
