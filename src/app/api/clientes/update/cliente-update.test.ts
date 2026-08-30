import { describe, expect, it } from 'vitest';

import {
  createClienteUpdateHandler,
  type ClienteBlingPort,
  type ClienteDependencies,
  type ClienteResponseBody,
  type ClienteStorePort,
  type ContatoBlingPayload,
} from './handler';
import { buildClienteRequest, clienteRequestSchema } from '@/lib/config/clienteContract';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';

const ORG = '11111111-1111-4111-8111-111111111111';
const ACTOR = '22222222-2222-4222-8222-222222222222';

/** SAFETY: o escopo é entrada do teste, não o que está sob teste. */
const scope = { organizationId: ORG, actorId: ACTOR, role: 'owner' } as unknown as VerifiedOrganizationScope;

interface FakeBling extends ClienteBlingPort {
  readonly criados: ContatoBlingPayload[];
  readonly atualizados: Array<{ id: string; payload: ContatoBlingPayload }>;
}

function fakeBling(options: { falhaCriar?: string; falhaAtualizar?: string } = {}): FakeBling {
  const criados: ContatoBlingPayload[] = [];
  const atualizados: Array<{ id: string; payload: ContatoBlingPayload }> = [];
  const falha = (message: string) => ({
    _tag: 'BlingFailed' as const,
    failure: { _tag: 'BlingProviderFailure' as const, type: 'VALIDATION_ERROR', status: 400, message, duplicateSale: false },
  });

  return {
    criados,
    atualizados,
    async criar(payload) {
      if (options.falhaCriar) return falha(options.falhaCriar);
      criados.push(payload);
      return { _tag: 'BlingOk' as const, value: { id: '5150' } };
    },
    async atualizar(id, payload) {
      if (options.falhaAtualizar) return falha(options.falhaAtualizar);
      atualizados.push({ id, payload });
      return { _tag: 'BlingOk' as const, value: undefined };
    },
  };
}

interface FakeStore extends ClienteStorePort {
  readonly gravados: Array<Record<string, unknown>>;
}

function fakeStore(options: { erro?: Error } = {}): FakeStore {
  const gravados: Array<Record<string, unknown>> = [];
  return {
    gravados,
    async upsert(_scope, cliente) {
      if (options.erro) throw options.erro;
      gravados.push({ ...cliente });
      return { id: 'cliente-local-1', blingId: cliente.blingId, nome: cliente.nome };
    },
  };
}

function deps(overrides: Partial<ClienteDependencies> = {}): ClienteDependencies {
  return {
    auth: { async authorize() { return { _tag: 'Authorized', scope }; } },
    bling: fakeBling(),
    store: fakeStore(),
    ...overrides,
  };
}

function requisicao(corpo: unknown): Request {
  return new Request('https://orbita.test/api/clientes/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(corpo),
  });
}

function corpoValido(overrides: Record<string, unknown> = {}) {
  return buildClienteRequest({ nome: 'Ana Souza', ...overrides });
}

describe('fronteira formulário <-> rota do cliente', () => {
  it('o corpo montado pelo builder do cliente é aceito pelo schema que a rota executa', () => {
    const corpo = buildClienteRequest({
      nome: 'Ana Souza', email: 'ana@exemplo.com', telefone: '4899990000', cpfCnpj: '12345678901', uf: 'SC',
    });

    expect(clienteRequestSchema.safeParse(corpo).success).toBe(true);
  });

  it('valida o documento por campo, em vez de deixar o Bling recusar', async () => {
    const handler = createClienteUpdateHandler(deps());
    const resposta = await handler(requisicao({ nome: 'Ana', cpfCnpj: '123' }));
    const corpo = (await resposta.json()) as ClienteResponseBody;

    expect(resposta.status).toBe(400);
    expect(corpo.error).toContain('CPF deve ter 11 dígitos');
  });

  it('recusa UF fora do formato de duas letras', async () => {
    const handler = createClienteUpdateHandler(deps());
    const resposta = await handler(requisicao({ nome: 'Ana', uf: 'Santa Catarina' }));

    expect(resposta.status).toBe(400);
  });

  it('recusa blingId que não é id numérico do Bling', async () => {
    const handler = createClienteUpdateHandler(deps());
    const resposta = await handler(requisicao({ nome: 'Ana', blingId: 'LOCAL-CLI-1700000000000' }));
    const corpo = (await resposta.json()) as ClienteResponseBody;

    expect(resposta.status).toBe(400);
    expect(corpo.error).toContain('blingId');
  });
});

describe('campos que o Bling realmente aceita', () => {
  it('deriva tipo J e indicadorIe 1 de um CNPJ', () => {
    const corpo = buildClienteRequest({ nome: 'Empresa', cpfCnpj: '12345678000199' });

    expect(corpo.tipo).toBe('J');
    expect(corpo.indicadorIe).toBe(1);
  });

  it('deriva tipo F e indicadorIe 9 de um CPF', () => {
    const corpo = buildClienteRequest({ nome: 'Ana', cpfCnpj: '12345678901' });

    expect(corpo.tipo).toBe('F');
    expect(corpo.indicadorIe).toBe(9);
  });

  it('não sobrescreve tipo e indicadorIe informados explicitamente', () => {
    const corpo = buildClienteRequest({ nome: 'Ana', cpfCnpj: '12345678000199', tipo: 'F', indicadorIe: 2 });

    expect(corpo.tipo).toBe('F');
    expect(corpo.indicadorIe).toBe(2);
  });

  it('leva telefone e documento até o adapter, sem campo inventado', async () => {
    const bling = fakeBling();
    const handler = createClienteUpdateHandler(deps({ bling }));

    await handler(requisicao(corpoValido({ telefone: '4899990000', cpfCnpj: '12345678901' })));

    // `contribuinte` e `fone` não existem no schema oficial; o payload do
    // adapter carrega `indicadorIe` e `telefone`.
    expect(bling.criados[0]).toMatchObject({ telefone: '4899990000', numeroDocumento: '12345678901', indicadorIe: 9 });
    expect(bling.criados[0]).not.toHaveProperty('contribuinte');
    expect(bling.criados[0]).not.toHaveProperty('fone');
  });
});

describe('o Bling é a fonte da verdade', () => {
  it('uma falha de atualização nunca vira criação — não duplica o contato', async () => {
    // Antes, um erro transitório no PUT (429, 500) fazia o código "degradar
    // para criação" e cadastrar um contato duplicado para quem já existia.
    const bling = fakeBling({ falhaAtualizar: 'Too many requests' });
    const store = fakeStore();
    const handler = createClienteUpdateHandler(deps({ bling, store }));

    const resposta = await handler(requisicao(corpoValido({ blingId: '4321' })));

    expect(resposta.status).toBe(400);
    expect(bling.criados).toHaveLength(0);
    expect(store.gravados).toHaveLength(0);
  });

  it('falha do provedor nunca vira sucesso na resposta', async () => {
    // Antes, quando PUT e POST falhavam, a rota devolvia `Synced` e gravava o
    // cliente localmente com um `LOCAL-CLI-<timestamp>` inventado.
    const bling = fakeBling({ falhaCriar: 'numeroDocumento inválido' });
    const store = fakeStore();
    const handler = createClienteUpdateHandler(deps({ bling, store }));

    const resposta = await handler(requisicao(corpoValido()));
    const corpo = (await resposta.json()) as ClienteResponseBody;

    expect(resposta.status).toBe(400);
    expect(corpo.success).toBe(false);
    expect(corpo.error).toContain('numeroDocumento inválido');
    expect(store.gravados).toHaveLength(0);
  });

  it('grava o id real devolvido pelo Bling, sem inventar identificador', async () => {
    const store = fakeStore();
    const handler = createClienteUpdateHandler(deps({ store }));

    const corpo = (await (await handler(requisicao(corpoValido()))).json()) as ClienteResponseBody;

    expect(corpo.client?.blingId).toBe('5150');
    expect(store.gravados[0]!.blingId).toBe('5150');
  });

  it('atualiza pelo id conhecido em vez de criar de novo', async () => {
    const bling = fakeBling();
    const handler = createClienteUpdateHandler(deps({ bling }));

    await handler(requisicao(corpoValido({ blingId: '4321' })));

    expect(bling.atualizados.map((a) => a.id)).toEqual(['4321']);
    expect(bling.criados).toHaveLength(0);
  });

  it('avisa que o contato já existe no Bling quando a gravação local falha', async () => {
    const store = fakeStore({ erro: new Error('conexão perdida') });
    const handler = createClienteUpdateHandler(deps({ store }));

    const resposta = await handler(requisicao(corpoValido()));
    const corpo = (await resposta.json()) as ClienteResponseBody;

    expect(resposta.status).toBe(500);
    expect(corpo.error).toContain('5150');
    expect(corpo.error).toContain('Sincronize os clientes');
  });
});

describe('autorização', () => {
  it('recusa sem tocar no Bling quando a capacidade é insuficiente', async () => {
    const bling = fakeBling();
    const handler = createClienteUpdateHandler(deps({
      bling,
      auth: {
        async authorize() {
          return {
            _tag: 'Denied',
            response: new Response(JSON.stringify({ success: false, error: 'Capacidade insuficiente' }), { status: 403 }) as never,
          };
        },
      },
    }));

    expect((await handler(requisicao(corpoValido()))).status).toBe(403);
    expect(bling.criados).toHaveLength(0);
  });
});
