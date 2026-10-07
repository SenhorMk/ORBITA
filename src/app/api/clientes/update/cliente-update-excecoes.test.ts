import { describe, expect, it, vi } from 'vitest';

import { buildClienteRequest } from '@/lib/config/clienteContract';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';

import {
  createClienteUpdateHandler,
  FALHA_AMBIGUA_NA_ATUALIZACAO,
  FALHA_AMBIGUA_NA_CRIACAO,
  type ClienteBlingPort,
  type ClienteDependencies,
  type ClienteResponseBody,
} from './handler';

/**
 * Criação × edição, e exceções do Bling. A edição (`PUT /contatos/{id}`)
 * caía na frase "o contato pode ter sido criado": uma exceção de
 * `fetchWithAuth` escapava do handler, a rota respondia 500 sem JSON e a tela
 * usava a frase genérica de criação.
 */

const ORG = '11111111-1111-4111-8111-111111111111';
/** SAFETY: o escopo é entrada do teste, não o que está sob teste. */
const scope = { organizationId: ORG, actorId: ORG, role: 'owner' } as unknown as VerifiedOrganizationScope;

const erroNomeado = (nome: string, mensagem: string) => Object.assign(new Error(mensagem), { name: nome });

function bling(overrides: Partial<ClienteBlingPort> = {}) {
  const chamadas: string[] = [];
  const porta: ClienteBlingPort = {
    async criar() { chamadas.push('POST'); return { _tag: 'BlingOk', value: { id: '5150' } }; },
    async atualizar() { chamadas.push('PUT'); return { _tag: 'BlingOk', value: undefined }; },
    ...overrides,
  };
  return { porta, chamadas };
}

function deps(porta: ClienteBlingPort, store?: ClienteDependencies['store']): ClienteDependencies {
  return {
    auth: { async authorize() { return { _tag: 'Authorized', scope }; } },
    bling: porta,
    store: store ?? { async upsert(_s, c) { return { id: 'local-1', blingId: c.blingId, nome: c.nome }; } },
  };
}

const pedido = (corpo: unknown) => new Request('https://orbita.test/api/clientes/update', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo),
});
// `tipo` e `indicadorIe` são escolhas explícitas obrigatórias no contrato.
const criacao = () => pedido(buildClienteRequest({ nome: 'Ana Souza', tipo: 'F', indicadorIe: 9 }));
const edicao = () => pedido(buildClienteRequest({ nome: 'Ana Souza', tipo: 'F', indicadorIe: 9, blingId: '4321', id: '33333333-3333-4333-8333-333333333333' }));

async function responder(d: ClienteDependencies, req: Request) {
  const r = await createClienteUpdateHandler(d)(req);
  return { status: r.status, tipo: r.headers.get('content-type'), corpo: (await r.json()) as ClienteResponseBody };
}

describe('exceção do Bling nunca escapa crua', () => {
  it('exceção em atualizar (rede) vira JSON estruturado de atualização ambígua, sem retrySafe', async () => {
    const { porta } = bling({ atualizar: async () => { throw new TypeError('fetch failed: ECONNRESET token=abc'); } });
    const r = await responder(deps(porta), edicao());
    expect(r).toMatchObject({ status: 502, corpo: { success: false, error: FALHA_AMBIGUA_NA_ATUALIZACAO } });
    expect(r.tipo).toContain('application/json');
    expect(r.corpo.retrySafe).toBeUndefined();
    expect(r.corpo.reconcileRequired).toBeUndefined();
  });

  it('exceção em criar vira JSON estruturado de criação ambígua, sem retrySafe', async () => {
    const { porta } = bling({ criar: async () => { throw new TypeError('fetch failed'); } });
    const r = await responder(deps(porta), criacao());
    expect(r).toMatchObject({ status: 502, corpo: { success: false, error: FALHA_AMBIGUA_NA_CRIACAO } });
    expect(r.corpo.retrySafe).toBeUndefined();
  });

  it('limite esgotado prova que nada foi processado: retrySafe, e a frase diz isso', async () => {
    const { porta } = bling({ atualizar: async () => { throw erroNomeado('BlingLimiteDeRequisicoesError', 'retries'); } });
    const r = await responder(deps(porta), edicao());
    expect(r.status).toBe(503);
    expect(r.corpo).toMatchObject({ retrySafe: true, error: expect.stringContaining('Nada foi alterado no Bling') });
  });

  it('acesso recusado prova que o pedido não foi autorizado; a mensagem do erro (token) não sai', async () => {
    const { porta } = bling({ criar: async () => { throw erroNomeado('BlingAcessoRecusadoError', 'Conexão Bling OAuth v3 (HTTP 401): refresh_token=xyz inválido'); } });
    const r = await responder(deps(porta), criacao());
    expect(r.corpo.retrySafe).toBe(true);
    expect(JSON.stringify(r.corpo)).not.toMatch(/refresh_token|xyz|OAuth v3/u);
  });

  it('nenhum detalhe do erro aparece na resposta', async () => {
    const { porta } = bling({ atualizar: async () => { throw new Error('Authorization: Bearer eyJsegredo; body={"error":"x"}'); } });
    const texto = JSON.stringify((await responder(deps(porta), edicao())).corpo);
    expect(texto).not.toMatch(/Bearer|eyJ|body=/u);
  });
});

describe('criação × edição', () => {
  it('edição ambígua (5xx) nunca diz "pode ter sido criado"', async () => {
    const { porta } = bling({
      atualizar: async () => ({ _tag: 'BlingFailed', failure: { _tag: 'BlingProviderFailure', type: 'HTTP_500', status: 500, message: 'erro', duplicateSale: false } }),
    });
    const r = await responder(deps(porta), edicao());
    expect(r.corpo.error).toBe(FALHA_AMBIGUA_NA_ATUALIZACAO);
    expect(r.corpo.error).not.toMatch(/criado/iu);
  });

  it('criação ambígua (5xx) diz "pode ter sido criado"', async () => {
    const { porta } = bling({
      criar: async () => ({ _tag: 'BlingFailed', failure: { _tag: 'BlingProviderFailure', type: 'HTTP_503', status: 503, message: 'erro', duplicateSale: false } }),
    });
    expect((await responder(deps(porta), criacao())).corpo.error).toBe(FALHA_AMBIGUA_NA_CRIACAO);
  });

  it('falha na edição nunca dispara POST como fallback do PUT', async () => {
    const { porta, chamadas } = bling({ atualizar: async () => { throw new TypeError('rede'); } });
    const criar = vi.spyOn(porta, 'criar');
    await responder(deps(porta), edicao());
    expect(criar).not.toHaveBeenCalled();
    expect(chamadas).not.toContain('POST');
  });

  it('408 na criação NÃO é recusa provada: criação ambígua, sem retrySafe', async () => {
    const { porta } = bling({
      criar: async () => ({ _tag: 'BlingFailed', failure: { _tag: 'BlingProviderFailure', type: 'HTTP_408', status: 408, message: 'Request Timeout', duplicateSale: false } }),
    });
    const r = await responder(deps(porta), criacao());
    expect(r.corpo.error).toBe(FALHA_AMBIGUA_NA_CRIACAO);
    expect(r.corpo.retrySafe).toBeUndefined();
  });

  it('408 na edição NÃO é recusa provada: atualização ambígua, sem retrySafe, nunca "criado"', async () => {
    const { porta } = bling({
      atualizar: async () => ({ _tag: 'BlingFailed', failure: { _tag: 'BlingProviderFailure', type: 'HTTP_408', status: 408, message: 'Request Timeout', duplicateSale: false } }),
    });
    const r = await responder(deps(porta), edicao());
    expect(r.corpo.error).toBe(FALHA_AMBIGUA_NA_ATUALIZACAO);
    expect(r.corpo.retrySafe).toBeUndefined();
    expect(r.corpo.error).not.toMatch(/pode ter sido criado/iu);
  });

  it('recusa com corpo fora do envelope do Bling (HTML, texto) não é repassada à tela', async () => {
    const { porta } = bling({
      atualizar: async () => ({ _tag: 'BlingFailed', failure: { _tag: 'BlingProviderFailure', type: 'HTTP_400', status: 400, message: '<html>nginx debug id=99</html>', duplicateSale: false } }),
    });
    const r = await responder(deps(porta), edicao());
    expect(r.corpo).toMatchObject({ retrySafe: true, error: 'O Bling recusou a atualização do contato: HTTP 400' });
  });

  it('recusa estruturada do Bling (validação) continua dizendo o motivo', async () => {
    const { porta } = bling({
      criar: async () => ({ _tag: 'BlingFailed', failure: { _tag: 'BlingProviderFailure', type: 'VALIDATION_ERROR', status: 400, message: 'numeroDocumento: CPF inválido', duplicateSale: false } }),
    });
    expect((await responder(deps(porta), criacao())).corpo.error).toBe('O Bling recusou o cadastro do contato: numeroDocumento: CPF inválido');
  });
});

describe('os caminhos felizes e a reconciliação continuam iguais', () => {
  it('atualização bem-sucedida persiste localmente com o blingId conhecido', async () => {
    const gravados: string[] = [];
    const { porta, chamadas } = bling();
    const r = await responder(deps(porta, { async upsert(_s, c) { gravados.push(c.blingId); return { id: 'local-1', blingId: c.blingId, nome: c.nome }; } }), edicao());
    expect(r.corpo.success).toBe(true);
    expect(gravados).toEqual(['4321']);
    expect(chamadas).toEqual(['PUT']);
  });

  it('criação continua funcionando', async () => {
    const { porta, chamadas } = bling();
    const r = await responder(deps(porta), criacao());
    expect(r.corpo).toMatchObject({ success: true, client: { blingId: '5150' } });
    expect(chamadas).toEqual(['POST']);
  });

  it('falha local depois do sucesso no Bling continua exigindo reconciliação (na edição também)', async () => {
    const { porta } = bling();
    const r = await responder(deps(porta, { async upsert() { throw new Error('23514'); } }), edicao());
    expect(r).toMatchObject({ status: 500, corpo: { reconcileRequired: true, blingId: '4321' } });
    expect(r.corpo.retrySafe).toBeUndefined();
  });
});
