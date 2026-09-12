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
    expect(corpo.error).toContain('Sincronize os clientes');
    // O id do contato saiu da FRASE e virou campo. A frase é fixa; o id é o
    // que a reconciliação precisa, e agora chega sem depender de alguém
    // reconhecê-lo dentro de um texto.
    expect(corpo.blingId).toBe('5150');
  });
});

/**
 * O diálogo de erro da tela mostrou, na captura da revisão, a linha que o
 * Postgres recusou — nome, e-mail e telefone do contato. O caminho era
 * `descreverErro(error)` interpolado na mensagem pública, e o Postgres escreve
 * valores de linha em `message`/`details`/`hint` numa violação de constraint.
 */
describe('a falha local não vaza a linha do banco', () => {
  /** O formato real de um erro de constraint do PostgREST, com PII dentro. */
  function erroDePostgresComPII(): Error {
    return Object.assign(new Error('new row for relation "clientes" violates check constraint "chk_cliente_uf"'), {
      code: '23514',
      details: 'Failing row contains (ana@exemplo.com, Ana Souza, 4899990000, , 12345678901).',
      hint: 'Verifique a coluna uf.',
    });
  }

  it('a resposta não traz mensagem, detalhe, dica, SQL nem PII do erro', async () => {
    const store = fakeStore({ erro: erroDePostgresComPII() });
    const handler = createClienteUpdateHandler(deps({ store }));

    const resposta = await handler(requisicao(corpoValido({ email: 'ana@exemplo.com', telefone: '4899990000' })));
    const bruto = await resposta.text();

    expect(resposta.status).toBe(500);
    for (const vazamento of [
      'chk_cliente_uf',
      '23514',
      'Failing row contains',
      'violates check constraint',
      'Verifique a coluna',
      'ana@exemplo.com',
      '4899990000',
      '12345678901',
    ]) {
      expect(bruto, `a resposta vazou "${vazamento}"`).not.toContain(vazamento);
    }
  });

  it('a frase pública é fixa e diz o que fazer', async () => {
    const store = fakeStore({ erro: erroDePostgresComPII() });
    const handler = createClienteUpdateHandler(deps({ store }));

    const corpo = (await (await handler(requisicao(corpoValido()))).json()) as ClienteResponseBody;

    expect(corpo.error).toBe(
      'Contato salvo no Bling, mas não foi possível concluir a gravação no ORBITA. '
      + 'Sincronize os clientes para reconciliar.',
    );
  });

  it('a mesma frase para causas diferentes: variar por causa é canal lateral', async () => {
    const handlerConstraint = createClienteUpdateHandler(deps({ store: fakeStore({ erro: erroDePostgresComPII() }) }));
    const handlerRede = createClienteUpdateHandler(deps({ store: fakeStore({ erro: new Error('ECONNRESET') }) }));

    const [a, b] = await Promise.all([
      (await handlerConstraint(requisicao(corpoValido()))).json() as Promise<ClienteResponseBody>,
      (await handlerRede(requisicao(corpoValido()))).json() as Promise<ClienteResponseBody>,
    ]);

    expect(a.error).toBe(b.error);
  });
});

/**
 * 2C — repetir depois de o provedor ter confirmado é destrutivo: o Bling já
 * criou o contato, e um segundo POST criaria outro. A resposta diz isso
 * nomeadamente para a tela não precisar adivinhar pelo texto.
 */
describe('falha parcial chega estruturada', () => {
  it('marca reconcileRequired quando o Bling confirmou e a gravação local falhou', async () => {
    const store = fakeStore({ erro: new Error('conexão perdida') });
    const handler = createClienteUpdateHandler(deps({ store }));

    const corpo = (await (await handler(requisicao(corpoValido()))).json()) as ClienteResponseBody;

    expect(corpo.success).toBe(false);
    expect(corpo.reconcileRequired).toBe(true);
    expect(corpo.blingId).toBe('5150');
  });

  it('a recusa do próprio Bling NÃO é reconciliação — ali nada foi criado', async () => {
    // Sem criação confirmada, repetir continua seguro: a marca precisa
    // distinguir os dois, senão a tela esconderia o retry legítimo.
    const handler = createClienteUpdateHandler(deps({ bling: fakeBling({ falhaCriar: 'documento inválido' }) }));

    const resposta = await handler(requisicao(corpoValido()));
    const corpo = (await resposta.json()) as ClienteResponseBody;

    expect(resposta.status).toBe(400);
    expect(corpo.reconcileRequired).toBeUndefined();
  });
});

/**
 * A UF: o contato era criado no Bling e a gravação local morria em
 * `chk_cliente_uf` (`uf IS NULL OR length(uf) = 2`), porque o formulário manda
 * `''` quando ninguém escolhe estado. A normalização vive na fronteira de
 * persistência (`ClienteRepository.upsert`, coberto em `ufDoCliente.test.ts`);
 * aqui se prova o que o handler entrega a ela, e o que o contrato recusa antes.
 */
describe('UF do contato', () => {
  it('cadastro sem UF chega ao store como vazio, e o normalizador o converte em NULL', async () => {
    const store = fakeStore();
    const handler = createClienteUpdateHandler(deps({ store }));

    const resposta = await handler(requisicao(corpoValido()));

    expect(resposta.status).toBe(200);
    expect(store.gravados[0]!.uf).toBe('');
  });

  it('UF de duas letras atravessa até o store', async () => {
    const store = fakeStore();
    const handler = createClienteUpdateHandler(deps({ store }));

    await handler(requisicao(corpoValido({ uf: 'PR' })));

    expect(store.gravados[0]!.uf).toBe('PR');
  });

  it('editar removendo a UF chega como vazio — e não como campo ausente', async () => {
    // É esta a diferença que faz a remoção acontecer: campo ausente num upsert
    // deixaria a coluna como estava.
    const store = fakeStore();
    const handler = createClienteUpdateHandler(deps({ store }));

    await handler(requisicao(corpoValido({ blingId: '4321', uf: '' })));

    expect(store.gravados[0]).toHaveProperty('uf');
    expect(store.gravados[0]!.uf).toBe('');
  });

  it('UF inválida é recusada pelo contrato, antes de qualquer escrita', async () => {
    const bling = fakeBling();
    const store = fakeStore();
    const handler = createClienteUpdateHandler(deps({ bling, store }));

    const resposta = await handler(requisicao({ nome: 'Ana Souza', uf: 'XYZ' }));

    expect(resposta.status).toBe(400);
    expect(bling.criados).toHaveLength(0);
    expect(store.gravados).toHaveLength(0);
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
