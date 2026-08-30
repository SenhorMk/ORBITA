import { describe, expect, it } from 'vitest';

import {
  createDespesaHandler,
  type ContaPagarPayload,
  type DespesaBlingPort,
  type DespesaDependencies,
  type DespesaResponseBody,
  type DespesaStorePort,
} from './despesaHandler';
import { buildDespesaRequest, despesaRequestSchema } from '@/lib/config/despesaContract';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';

const ORG = '11111111-1111-4111-8111-111111111111';
const ACTOR = '22222222-2222-4222-8222-222222222222';
const CATEGORIA = '33333333-3333-4333-8333-333333333333';

/** SAFETY: o escopo é entrada do teste, não o que está sob teste. */
const scope = { organizationId: ORG, actorId: ACTOR, role: 'owner' } as unknown as VerifiedOrganizationScope;

interface FakeBling extends DespesaBlingPort {
  readonly criadas: ContaPagarPayload[];
  readonly baixadas: Array<{ id: string; portadorId: number; categoriaId: number }>;
}

function fakeBling(options: {
  falhaCriar?: string;
  falhaPortador?: string;
  falhaBaixa?: string;
  falhaContato?: string;
} = {}): FakeBling {
  const criadas: ContaPagarPayload[] = [];
  const baixadas: Array<{ id: string; portadorId: number; categoriaId: number }> = [];
  const falha = (message: string) => ({
    _tag: 'BlingFailed' as const,
    failure: { _tag: 'BlingProviderFailure' as const, type: 'VALIDATION_ERROR', status: 400, message, duplicateSale: false },
  });

  return {
    criadas,
    baixadas,
    async resolverContatoPadrao() {
      if (options.falhaContato) return falha(options.falhaContato);
      return { _tag: 'BlingOk' as const, value: 7001 };
    },
    async criarContaPagar(payload) {
      if (options.falhaCriar) return falha(options.falhaCriar);
      criadas.push(payload);
      return { _tag: 'BlingOk' as const, value: { id: '88123' } };
    },
    async obterPortadorPadrao() {
      if (options.falhaPortador) return falha(options.falhaPortador);
      return { _tag: 'BlingOk' as const, value: 55 };
    },
    async baixarContaPagar(id, payload) {
      if (options.falhaBaixa) return falha(options.falhaBaixa);
      baixadas.push({ id, portadorId: payload.portadorId, categoriaId: payload.categoriaId });
      return { _tag: 'BlingOk' as const, value: undefined };
    },
  };
}

interface FakeStore extends DespesaStorePort {
  readonly salvos: Array<Record<string, unknown>>;
}

function fakeStore(options: { categoriaBlingId?: number | null; erro?: Error } = {}): FakeStore {
  const salvos: Array<Record<string, unknown>> = [];
  return {
    salvos,
    async resolverCategoriaBling() {
      return options.categoriaBlingId === undefined ? 900 : options.categoriaBlingId;
    },
    async salvarTitulo(_scope, titulo) {
      if (options.erro) throw options.erro;
      salvos.push({ ...titulo });
      return { id: 'titulo-1', blingId: titulo.blingId, situacao: titulo.situacao };
    },
  };
}

function deps(overrides: Partial<DespesaDependencies> = {}): DespesaDependencies {
  return {
    auth: { async authorize() { return { _tag: 'Authorized', scope }; } },
    bling: fakeBling(),
    store: fakeStore(),
    hoje: () => '2026-08-29',
    ...overrides,
  };
}

function requisicao(corpo: unknown): Request {
  return new Request('https://orbita.test/api/financeiro', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(corpo),
  });
}

function corpoValido(overrides: Record<string, unknown> = {}) {
  return buildDespesaRequest({
    descricao: 'Aluguel', valor: 1200, dataVencimento: '2026-09-10', categoriaId: CATEGORIA, ...overrides,
  });
}

describe('fronteira formulário <-> rota da despesa', () => {
  it('o corpo montado pelo builder do cliente é aceito pelo schema que a rota executa', () => {
    expect(despesaRequestSchema.safeParse(corpoValido()).success).toBe(true);
  });

  it('recusa data fora do formato AAAA-MM-DD exigido pelo Bling', async () => {
    const handler = createDespesaHandler(deps());
    const resposta = await handler(requisicao({ descricao: 'X', valor: 10, dataVencimento: '10/09/2026' }));
    const corpo = (await resposta.json()) as DespesaResponseBody;

    expect(resposta.status).toBe(400);
    expect(corpo.error).toContain('AAAA-MM-DD');
  });

  it('recusa valor zero ou negativo', async () => {
    const handler = createDespesaHandler(deps());

    expect((await handler(requisicao({ descricao: 'X', valor: 0, dataVencimento: '2026-09-10' }))).status).toBe(400);
    expect((await handler(requisicao({ descricao: 'X', valor: -5, dataVencimento: '2026-09-10' }))).status).toBe(400);
  });

  it('recusa valor como string, que o Bling exige como número', async () => {
    const handler = createDespesaHandler(deps());
    const resposta = await handler(requisicao({ descricao: 'X', valor: '1200', dataVencimento: '2026-09-10' }));

    expect(resposta.status).toBe(400);
  });
});

describe('payload da conta a pagar', () => {
  it('envia contato, vencimento e valor — os obrigatórios do schema oficial', async () => {
    const bling = fakeBling();
    const handler = createDespesaHandler(deps({ bling }));

    await handler(requisicao(corpoValido()));

    expect(bling.criadas[0]).toMatchObject({
      contatoId: 7001, vencimento: '2026-09-10', valor: 1200, historico: 'Aluguel',
    });
  });

  it('nunca envia situacao, que é readOnly na criação', async () => {
    const bling = fakeBling();
    const handler = createDespesaHandler(deps({ bling }));

    await handler(requisicao(corpoValido({ pago: true })));

    expect(bling.criadas[0]).not.toHaveProperty('situacao');
  });

  it('usa o contato informado em vez de resolver o padrão', async () => {
    const bling = fakeBling();
    const handler = createDespesaHandler(deps({ bling }));

    await handler(requisicao(corpoValido({ contatoBlingId: 4242 })));

    expect(bling.criadas[0]!.contatoId).toBe(4242);
  });
});

describe('quitação da despesa', () => {
  it('quita pelo endpoint próprio quando marcada como paga', async () => {
    const bling = fakeBling();
    const store = fakeStore();
    const handler = createDespesaHandler(deps({ bling, store }));

    const corpo = (await (await handler(requisicao(corpoValido({ pago: true })))).json()) as DespesaResponseBody;

    expect(bling.baixadas).toEqual([{ id: '88123', portadorId: 55, categoriaId: 900 }]);
    expect(store.salvos[0]!.situacao).toBe('pago');
    expect(corpo.avisos).toEqual([]);
  });

  it('grava aberto quando a quitação falha — os dois lados contam a mesma coisa', async () => {
    // Antes o código mandava `situacao: 2` na criação (ignorado, pois é
    // readOnly) e gravava 'pago' localmente: a conta ficava aberta no ERP e
    // quitada no ORBITA.
    const bling = fakeBling({ falhaBaixa: 'Portador inválido' });
    const store = fakeStore();
    const handler = createDespesaHandler(deps({ bling, store }));

    const resposta = await handler(requisicao(corpoValido({ pago: true })));
    const corpo = (await resposta.json()) as DespesaResponseBody;

    expect(resposta.status).toBe(200);
    expect(store.salvos[0]!.situacao).toBe('aberto');
    expect(corpo.avisos?.join(' ')).toContain('continua em aberto no ERP');
  });

  it('avisa quando a conta Bling não tem conta financeira para quitar', async () => {
    const bling = fakeBling({ falhaPortador: 'Nenhuma conta financeira cadastrada no Bling' });
    const store = fakeStore();
    const handler = createDespesaHandler(deps({ bling, store }));

    const corpo = (await (await handler(requisicao(corpoValido({ pago: true })))).json()) as DespesaResponseBody;

    expect(store.salvos[0]!.situacao).toBe('aberto');
    expect(corpo.avisos?.join(' ')).toContain('conta financeira');
  });

  it('avisa quando a categoria não está sincronizada, já que a quitação a exige', async () => {
    const bling = fakeBling();
    const store = fakeStore({ categoriaBlingId: null });
    const handler = createDespesaHandler(deps({ bling, store }));

    const corpo = (await (await handler(requisicao(corpoValido({ pago: true })))).json()) as DespesaResponseBody;

    expect(bling.baixadas).toHaveLength(0);
    expect(store.salvos[0]!.situacao).toBe('aberto');
    expect(corpo.avisos?.join(' ')).toContain('categoria sincronizada');
  });

  it('não tenta quitar quando a despesa não é marcada como paga', async () => {
    const bling = fakeBling();
    const handler = createDespesaHandler(deps({ bling }));

    await handler(requisicao(corpoValido()));

    expect(bling.baixadas).toHaveLength(0);
  });
});

describe('o Bling é a fonte da verdade', () => {
  it('não grava localmente quando o Bling recusa o lançamento', async () => {
    const bling = fakeBling({ falhaCriar: 'contato.id inválido' });
    const store = fakeStore();
    const handler = createDespesaHandler(deps({ bling, store }));

    const resposta = await handler(requisicao(corpoValido()));
    const corpo = (await resposta.json()) as DespesaResponseBody;

    expect(resposta.status).toBe(400);
    expect(corpo.error).toContain('contato.id inválido');
    expect(store.salvos).toHaveLength(0);
  });

  it('grava o id real devolvido pelo Bling', async () => {
    const store = fakeStore();
    const handler = createDespesaHandler(deps({ store }));

    const corpo = (await (await handler(requisicao(corpoValido()))).json()) as DespesaResponseBody;

    expect(corpo.data?.blingId).toBe('88123');
  });

  it('avisa que a despesa já existe no Bling quando a gravação local falha', async () => {
    const store = fakeStore({ erro: new Error('conexão perdida') });
    const handler = createDespesaHandler(deps({ store }));

    const resposta = await handler(requisicao(corpoValido()));
    const corpo = (await resposta.json()) as DespesaResponseBody;

    expect(resposta.status).toBe(500);
    expect(corpo.error).toContain('88123');
  });
});

describe('modo interno', () => {
  it('grava só localmente, sem tocar no Bling', async () => {
    const bling = fakeBling();
    const store = fakeStore();
    const handler = createDespesaHandler(deps({ bling, store }));

    const corpo = (await (await handler(requisicao(corpoValido({ modo: 'interno' })))).json()) as DespesaResponseBody;

    expect(bling.criadas).toHaveLength(0);
    expect(corpo.data?.blingId).toBeNull();
  });
});
