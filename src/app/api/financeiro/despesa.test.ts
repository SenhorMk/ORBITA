import { describe, expect, it } from 'vitest';
import { NextResponse } from 'next/server';

import {
  createDespesaHandler,
  type ContaPagarPayload,
  type DespesaBlingPort,
  type DespesaDependencies,
  type DespesaResponseBody,
  type DespesaStorePort,
  type GravacaoDeTentativa,
  type IntencaoDeContaPagar,
} from './despesaHandler';
import { buildDespesaRequest, despesaRequestSchema } from '@/lib/config/despesaContract';
import type { EnvioDeCriacaoAoBling } from '@/lib/integrations/bling/classificacaoDeFalhaDeCriacao';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';

const ORG = '11111111-1111-4111-8111-111111111111';
const ORG_B = '44444444-4444-4444-8444-444444444444';
const ACTOR = '22222222-2222-4222-8222-222222222222';
const CATEGORIA = '33333333-3333-4333-8333-333333333333';
const CHAVE = '55555555-5555-4555-8555-555555555555';
const OUTRA_CHAVE = '66666666-6666-4666-8666-666666666666';

/** SAFETY: o escopo é entrada do teste, não o que está sob teste. */
const scope = { organizationId: ORG, actorId: ACTOR, role: 'owner' } as unknown as VerifiedOrganizationScope;
/** SAFETY: idem, para a organização B. */
const scopeB = { organizationId: ORG_B, actorId: ACTOR, role: 'owner' } as unknown as VerifiedOrganizationScope;

// ---------------------------------------------------------------------------
// Bling fake. Separa o que ACONTECEU no Bling (`contasCriadasNoBling`) do que a
// resposta diz — é isso que deixa um teste de ACK perdido falhar com dois POSTs.
// ---------------------------------------------------------------------------

type ModoDeCriacao =
  | 'confirma'
  | 'perde-ack' // cria no Bling e a resposta se perde (prazo/conexão)
  | 'timeout-sem-criar' // nada criado, mas também nada voltou
  | 'sem-credencial' // nenhuma requisição sai
  | 'erro-5xx' // o Bling responde 500 — e pode ter criado
  | 'sucesso-sem-id' // cria e responde 2xx sem id
  | 'recusa'; // VALIDATION_ERROR 400

interface FakeBling extends DespesaBlingPort {
  /** Payloads que CHEGARAM ao Bling, criando ou não. */
  readonly posts: ContaPagarPayload[];
  /** Contas que EXISTEM no Bling. A contraprova principal conta isto. */
  readonly contasCriadasNoBling: () => number;
  readonly baixadas: Array<{ id: string; portadorId: number; categoriaId: number }>;
}

function falhaBling(type: string, status: number, message: string) {
  return {
    _tag: 'BlingFailed' as const,
    failure: { _tag: 'BlingProviderFailure' as const, type, status, message, duplicateSale: false },
  };
}

function fakeBling(options: {
  modo?: ModoDeCriacao;
  falhaCriar?: string;
  falhaPortador?: string;
  falhaBaixa?: string;
  baixaAmbigua?: boolean;
  falhaContato?: string;
  /** Chamado no instante do POST — antes de qualquer resposta. */
  aoReceberPost?: () => void;
  /** Segura a resposta até a promessa resolver (corrida). */
  segurarResposta?: Promise<void>;
} = {}): FakeBling {
  const posts: ContaPagarPayload[] = [];
  const baixadas: Array<{ id: string; portadorId: number; categoriaId: number }> = [];
  let criadas = 0;
  const modo: ModoDeCriacao = options.falhaCriar ? 'recusa' : options.modo ?? 'confirma';

  return {
    posts,
    baixadas,
    contasCriadasNoBling: () => criadas,
    async resolverContatoPadrao() {
      if (options.falhaContato) return falhaBling('VALIDATION_ERROR', 400, options.falhaContato);
      return { _tag: 'BlingOk' as const, value: 7001 };
    },
    async criarContaPagar(payload): Promise<EnvioDeCriacaoAoBling<{ id: string }>> {
      if (modo === 'sem-credencial') return { _tag: 'NaoEnviado', motivo: 'credencial_indisponivel' };
      posts.push(payload);
      options.aoReceberPost?.();
      if (options.segurarResposta) await options.segurarResposta;
      switch (modo) {
        case 'confirma':
          criadas++;
          return { _tag: 'Despachado', resultado: { _tag: 'BlingOk', value: { id: String(88122 + criadas) } } };
        case 'perde-ack':
          criadas++;
          return { _tag: 'Despachado', resultado: falhaBling('UNKNOWN_ERROR', 0, 'prazo esgotado') };
        case 'timeout-sem-criar':
          return { _tag: 'Despachado', resultado: falhaBling('UNKNOWN_ERROR', 0, 'prazo esgotado') };
        case 'erro-5xx':
          criadas++;
          return { _tag: 'Despachado', resultado: falhaBling('SERVER_ERROR', 500, 'Erro interno') };
        case 'sucesso-sem-id':
          criadas++;
          return { _tag: 'Despachado', resultado: falhaBling('INVALID_RESPONSE', 201, 'sem id') };
        case 'recusa':
          return { _tag: 'Despachado', resultado: falhaBling('VALIDATION_ERROR', 400, options.falhaCriar ?? 'contato.id inválido') };
      }
    },
    async obterPortadorPadrao() {
      if (options.falhaPortador) return falhaBling('VALIDATION_ERROR', 400, options.falhaPortador);
      return { _tag: 'BlingOk' as const, value: 55 };
    },
    async baixarContaPagar(id, payload) {
      if (options.baixaAmbigua) return falhaBling('UNKNOWN_ERROR', 0, 'prazo esgotado');
      if (options.falhaBaixa) return falhaBling('VALIDATION_ERROR', 400, options.falhaBaixa);
      baixadas.push({ id, portadorId: payload.portadorId, categoriaId: payload.categoriaId });
      return { _tag: 'BlingOk' as const, value: undefined };
    },
  };
}

// ---------------------------------------------------------------------------
// Store em memória com as MESMAS regras da migration 73: chave por
// organização, digest, pendência idêntica (em_voo/indeterminada) e CAS por
// estado+época. A própria migration é provada no pgTAP e na corrida real.
// ---------------------------------------------------------------------------

type EstadoTentativa = 'em_voo' | 'nao_enviada' | 'confirmada' | 'recusada' | 'indeterminada';

interface TentativaFake {
  readonly id: string;
  readonly org: string;
  readonly chave: string;
  readonly digest: string;
  estado: EstadoTentativa;
  epoca: number;
  blingContaId: string | null;
  tituloId: string | null;
  contatoBlingId: number | null;
  motivo: string | null;
}

interface FakeStore extends DespesaStorePort {
  readonly salvos: Array<Record<string, unknown>>;
  readonly tentativas: TentativaFake[];
  tentativa(org: string, chave: string): TentativaFake | undefined;
}

function fakeStore(options: {
  categoriaBlingId?: number | null;
  erro?: Error;
  /** Quantas gravações de título falham antes de voltar a funcionar. */
  falhasDeTitulo?: number;
  reivindicacaoIndisponivel?: boolean;
  concluirFalha?: boolean;
} = {}): FakeStore {
  const salvos: Array<Record<string, unknown>> = [];
  const tentativas: TentativaFake[] = [];
  let falhasDeTitulo = options.falhasDeTitulo ?? 0;
  let seq = 0;

  const pendente = (org: string, digest: string) =>
    tentativas.find((t) => t.org === org && t.digest === digest && (t.estado === 'em_voo' || t.estado === 'indeterminada'));

  return {
    salvos,
    tentativas,
    tentativa: (org, chave) => tentativas.find((t) => t.org === org && t.chave === chave),
    async resolverCategoriaBling() {
      return options.categoriaBlingId === undefined ? 900 : options.categoriaBlingId;
    },
    async salvarTitulo(_scope, titulo) {
      if (options.erro) throw options.erro;
      if (falhasDeTitulo > 0) {
        falhasDeTitulo--;
        throw new Error('conexão perdida');
      }
      salvos.push({ ...titulo });
      return { id: `titulo-${salvos.length}`, blingId: titulo.blingId, situacao: titulo.situacao };
    },
    async reivindicarTentativa(s, intencao: IntencaoDeContaPagar) {
      if (options.reivindicacaoIndisponivel) return { _tag: 'TentativaIndisponivel' as const };
      const org = s.organizationId;
      const existente = tentativas.find((t) => t.org === org && t.chave === intencao.chave);
      if (!existente) {
        const outra = pendente(org, intencao.digest);
        if (outra) return { _tag: 'PendenciaIdentica' as const, chavePendente: outra.chave };
        const nova: TentativaFake = {
          id: `tentativa-${++seq}`, org, chave: intencao.chave, digest: intencao.digest, estado: 'em_voo', epoca: 1,
          blingContaId: null, tituloId: null, contatoBlingId: intencao.contatoBlingId, motivo: null,
        };
        tentativas.push(nova);
        return { _tag: 'TentativaPropria' as const, tentativaId: nova.id, epoca: 1 };
      }
      if (existente.digest !== intencao.digest) return { _tag: 'ConflitoDeConteudo' as const };
      if (existente.estado === 'nao_enviada') {
        const outra = pendente(org, intencao.digest);
        if (outra) return { _tag: 'PendenciaIdentica' as const, chavePendente: outra.chave };
        existente.estado = 'em_voo';
        existente.epoca++;
        return { _tag: 'TentativaPropria' as const, tentativaId: existente.id, epoca: existente.epoca };
      }
      return {
        _tag: 'TentativaRepetida' as const,
        tentativaId: existente.id,
        estado: existente.estado,
        blingContaId: existente.blingContaId,
        tituloId: existente.tituloId,
        contatoBlingId: existente.contatoBlingId,
      };
    },
    async concluirTentativa(s, { tentativaId, epoca }, desfecho): Promise<GravacaoDeTentativa> {
      if (options.concluirFalha) return 'NaoGravado';
      const t = tentativas.find((x) => x.id === tentativaId && x.org === s.organizationId);
      if (!t || t.estado !== 'em_voo' || t.epoca !== epoca) return 'NaoGravado';
      t.estado = desfecho.estado;
      if (desfecho.estado === 'confirmada') t.blingContaId = desfecho.blingContaId;
      else t.motivo = desfecho.motivo;
      if (desfecho.contatoBlingId !== null) t.contatoBlingId = desfecho.contatoBlingId;
      return 'Gravado';
    },
    async vincularTitulo(s, tentativaId, tituloId): Promise<GravacaoDeTentativa> {
      const t = tentativas.find((x) => x.id === tentativaId && x.org === s.organizationId);
      if (!t || t.estado !== 'confirmada' || t.tituloId !== null) return 'NaoGravado';
      t.tituloId = tituloId;
      return 'Gravado';
    },
  };
}

function deps(overrides: Partial<DespesaDependencies> = {}): DespesaDependencies {
  let chaves = 0;
  return {
    auth: { async authorize() { return { _tag: 'Authorized', scope }; } },
    bling: fakeBling(),
    store: fakeStore(),
    hoje: () => '2026-08-29',
    novaChave: () => `77777777-7777-4777-8777-${String(++chaves).padStart(12, '0')}`,
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

async function enviar(handler: ReturnType<typeof createDespesaHandler>, corpo: unknown) {
  const resposta = await handler(requisicao(corpo));
  return { status: resposta.status, corpo: (await resposta.json()) as DespesaResponseBody };
}

describe('fronteira formulário <-> rota da despesa', () => {
  it('o corpo montado pelo builder do cliente é aceito pelo schema que a rota executa', () => {
    expect(despesaRequestSchema.safeParse(corpoValido({ chaveIdempotencia: CHAVE })).success).toBe(true);
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

  it('recusa uma chave de operação que não é UUID, sem registrar intenção nem chamar o Bling', async () => {
    const bling = fakeBling();
    const store = fakeStore();
    const handler = createDespesaHandler(deps({ bling, store }));

    const { status } = await enviar(handler, { ...corpoValido(), chaveIdempotencia: 'Date.now()-1' });

    expect(status).toBe(400);
    expect(store.tentativas).toHaveLength(0);
    expect(bling.posts).toHaveLength(0);
  });
});

describe('payload da conta a pagar', () => {
  it('envia contato, vencimento e valor — os obrigatórios do schema oficial', async () => {
    const bling = fakeBling();
    const handler = createDespesaHandler(deps({ bling }));

    await handler(requisicao(corpoValido()));

    expect(bling.posts[0]).toMatchObject({
      contatoId: 7001, vencimento: '2026-09-10', valor: 1200, historico: 'Aluguel',
    });
  });

  it('nunca envia situacao, que é readOnly na criação', async () => {
    const bling = fakeBling();
    const handler = createDespesaHandler(deps({ bling }));

    await handler(requisicao(corpoValido({ pago: true })));

    expect(bling.posts[0]).not.toHaveProperty('situacao');
  });

  it('usa o contato informado em vez de resolver o padrão', async () => {
    const bling = fakeBling();
    const handler = createDespesaHandler(deps({ bling }));

    await handler(requisicao(corpoValido({ contatoBlingId: 4242 })));

    expect(bling.posts[0]!.contatoId).toBe(4242);
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

  it('quitação sem resposta não é dita como falha: pede para conferir antes de quitar de novo', async () => {
    const bling = fakeBling({ baixaAmbigua: true });
    const store = fakeStore();
    const handler = createDespesaHandler(deps({ bling, store }));

    const { status, corpo } = await enviar(handler, corpoValido({ pago: true }));

    expect(status).toBe(200);
    expect(store.salvos[0]!.situacao).toBe('aberto');
    expect(corpo.avisos?.join(' ')).toContain('não foi confirmada');
    expect(corpo.avisos?.join(' ')).not.toContain('falhou');
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
  it('grava só localmente, sem tocar no Bling nem registrar tentativa', async () => {
    const bling = fakeBling();
    const store = fakeStore();
    const handler = createDespesaHandler(deps({ bling, store }));

    const corpo = (await (await handler(requisicao(corpoValido({ modo: 'interno' })))).json()) as DespesaResponseBody;

    expect(bling.posts).toHaveLength(0);
    expect(store.tentativas).toHaveLength(0);
    expect(corpo.data?.blingId).toBeNull();
  });
});

describe('o que a despesa deixa no histórico', () => {
  it('grava título e descrição como campos distintos, sem mandar o título para o Bling', async () => {
    const bling = fakeBling();
    const store = fakeStore();
    const handler = createDespesaHandler(deps({ bling, store }));

    await handler(requisicao(corpoValido({ titulo: 'Insumos', descricao: '1kg de rapé para revenda' })));

    expect(store.salvos[0]).toMatchObject({ titulo: 'Insumos', descricao: '1kg de rapé para revenda' });
    // O ERP não tem o conceito: lá continua existindo só o `historico`.
    expect(bling.posts[0]!.historico).toBe('1kg de rapé para revenda');
  });

  it('uma despesa sem título continua válida — a coluna é opcional e nasce nula', async () => {
    const store = fakeStore();
    const handler = createDespesaHandler(deps({ store }));

    const resposta = await handler(requisicao(corpoValido()));

    expect(resposta.status).toBe(200);
    expect(store.salvos[0]!.titulo).toBeUndefined();
  });

  it('registra o contato informado e o nome dele no momento do lançamento', async () => {
    const store = fakeStore();
    const handler = createDespesaHandler(deps({ store }));

    await handler(requisicao(corpoValido({ contatoBlingId: 4242, contatoNome: 'Fornecedor Exemplo LTDA' })));

    expect(store.salvos[0]).toMatchObject({
      fornecedorBlingId: 4242,
      fornecedorNome: 'Fornecedor Exemplo LTDA',
    });
  });

  it('sem contato informado, registra o padrão que o SERVIDOR resolveu — não um id do cliente', async () => {
    const store = fakeStore();
    const handler = createDespesaHandler(deps({ store }));

    await handler(requisicao(corpoValido()));

    expect(store.salvos[0]!.fornecedorBlingId).toBe(7001);
  });

  it('o modo interno não inventa fornecedor: não há contato no Bling para registrar', async () => {
    const store = fakeStore();
    const handler = createDespesaHandler(deps({ store }));

    await handler(requisicao(corpoValido({ modo: 'interno', contatoBlingId: 4242, contatoNome: 'X' })));

    expect(store.salvos[0]!.fornecedorBlingId).toBeUndefined();
    expect(store.salvos[0]!.fornecedorNome).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// PRE-001: a intenção durável antes do POST.
// ---------------------------------------------------------------------------

describe('PRE-001 — a intenção existe antes do POST', () => {
  it('no instante do POST a tentativa já está gravada em_voo, com a chave do cliente', async () => {
    const store = fakeStore();
    let noInstanteDoPost: string | undefined;
    const bling = fakeBling({ aoReceberPost: () => { noInstanteDoPost = store.tentativa(ORG, CHAVE)?.estado; } });
    const handler = createDespesaHandler(deps({ bling, store }));

    await enviar(handler, corpoValido({ chaveIdempotencia: CHAVE }));

    expect(noInstanteDoPost).toBe('em_voo');
  });

  it('chamada normal: confirmada, com operation_ref e o id remoto gravados na tentativa', async () => {
    const store = fakeStore();
    const handler = createDespesaHandler(deps({ store }));

    const { status, corpo } = await enviar(handler, corpoValido({ chaveIdempotencia: CHAVE }));

    expect(status).toBe(200);
    expect(corpo.operacao).toEqual({ ref: CHAVE, estado: 'confirmada' });
    expect(store.tentativa(ORG, CHAVE)).toMatchObject({ estado: 'confirmada', blingContaId: '88123', tituloId: 'titulo-1' });
  });

  it('sem chave do cliente, o servidor gera uma ANTES do POST e a devolve', async () => {
    const store = fakeStore();
    const handler = createDespesaHandler(deps({ store }));

    const { corpo } = await enviar(handler, corpoValido());

    expect(corpo.operacao?.ref).toBe('77777777-7777-4777-8777-000000000001');
    expect(store.tentativas[0]!.chave).toBe(corpo.operacao?.ref);
  });

  it('não chama o Bling quando não consegue registrar a intenção (falha fechada)', async () => {
    const bling = fakeBling();
    const handler = createDespesaHandler(deps({ bling, store: fakeStore({ reivindicacaoIndisponivel: true }) }));

    const { status, corpo } = await enviar(handler, corpoValido({ chaveIdempotencia: CHAVE }));

    expect(status).toBe(503);
    expect(corpo.error).toContain('Nada foi enviado');
    expect(bling.posts).toHaveLength(0);
  });
});

describe('PRE-001 — ACK perdido (contraprova principal)', () => {
  it('o Bling cria, a resposta se perde, o usuário repete: continua existindo UMA conta', async () => {
    const bling = fakeBling({ modo: 'perde-ack' });
    const store = fakeStore();
    const handler = createDespesaHandler(deps({ bling, store }));
    const corpo = corpoValido({ chaveIdempotencia: CHAVE });

    const primeira = await enviar(handler, corpo);
    const repeticao = await enviar(handler, corpo);
    const terceira = await enviar(handler, corpo);

    // A contraprova vem primeiro: é ela que um reenvio quebra.
    expect(bling.contasCriadasNoBling()).toBe(1);
    expect(bling.posts).toHaveLength(1);
    expect(primeira.status).toBe(202);
    expect(primeira.corpo.operacao).toEqual({ ref: CHAVE, estado: 'indeterminada' });
    expect(repeticao.corpo.operacao).toEqual({ ref: CHAVE, estado: 'indeterminada' });
    expect(terceira.status).toBe(202);
    expect(store.salvos).toHaveLength(0);
  });

  it('a resposta de resultado não confirmado diz que pode ter sido criada, e não que foi recusada', async () => {
    const handler = createDespesaHandler(deps({ bling: fakeBling({ modo: 'perde-ack' }) }));

    const { corpo } = await enviar(handler, corpoValido({ chaveIdempotencia: CHAVE }));

    expect(corpo.success).toBe(false);
    expect(corpo.error).toContain('pode ter sido criada');
    expect(corpo.error).toContain('Não lance de novo');
    expect(corpo.error).not.toContain('recusou');
  });

  it('recarregar a página perde a chave: o mesmo lançamento com chave nova também não reenvia', async () => {
    const bling = fakeBling({ modo: 'perde-ack' });
    const store = fakeStore();
    const handler = createDespesaHandler(deps({ bling, store }));

    await enviar(handler, corpoValido({ chaveIdempotencia: CHAVE }));
    const depoisDoReload = await enviar(handler, corpoValido({ chaveIdempotencia: OUTRA_CHAVE }));

    expect(depoisDoReload.status).toBe(202);
    expect(depoisDoReload.corpo.operacao).toEqual({ ref: CHAVE, estado: 'em_voo' });
    expect(bling.contasCriadasNoBling()).toBe(1);
    expect(store.tentativa(ORG, OUTRA_CHAVE)).toBeUndefined();
  });
});

describe('PRE-001 — classificação de falhas', () => {
  it.each([
    ['timeout depois de enviar', 'timeout-sem-criar', 'sem_resposta'],
    ['falha de rede ambígua', 'perde-ack', 'sem_resposta'],
    ['5xx do provedor', 'erro-5xx', 'erro_do_provedor'],
    ['2xx sem id', 'sucesso-sem-id', 'resposta_invalida'],
  ] as const)('%s → indeterminada (%s), nunca recusa', async (_nome, modo, motivo) => {
    const bling = fakeBling({ modo });
    const store = fakeStore();
    const handler = createDespesaHandler(deps({ bling, store }));

    const { status, corpo } = await enviar(handler, corpoValido({ chaveIdempotencia: CHAVE }));
    await enviar(handler, corpoValido({ chaveIdempotencia: CHAVE }));

    expect(status).toBe(202);
    expect(corpo.operacao?.estado).toBe('indeterminada');
    expect(store.tentativa(ORG, CHAVE)).toMatchObject({ estado: 'indeterminada', motivo });
    expect(bling.posts).toHaveLength(1);
  });

  it('falha comprovadamente antes do envio: nao_enviada, e a MESMA intenção pode ser enviada de novo', async () => {
    const store = fakeStore();
    const semCredencial = createDespesaHandler(deps({ bling: fakeBling({ modo: 'sem-credencial' }), store }));

    const primeira = await enviar(semCredencial, corpoValido({ chaveIdempotencia: CHAVE }));
    expect(primeira.status).toBe(503);
    expect(primeira.corpo.operacao).toEqual({ ref: CHAVE, estado: 'nao_enviada' });
    expect(store.tentativa(ORG, CHAVE)).toMatchObject({ estado: 'nao_enviada', motivo: 'credencial_indisponivel' });

    const bling = fakeBling();
    const reconectado = createDespesaHandler(deps({ bling, store }));
    const segunda = await enviar(reconectado, corpoValido({ chaveIdempotencia: CHAVE }));

    expect(segunda.status).toBe(200);
    expect(store.tentativa(ORG, CHAVE)).toMatchObject({ estado: 'confirmada', epoca: 2 });
    expect(bling.contasCriadasNoBling()).toBe(1);
  });

  it('fornecedor não resolvido: nada foi enviado, e a tentativa fica nao_enviada', async () => {
    const bling = fakeBling({ falhaContato: 'Contato inválido' });
    const store = fakeStore();
    const handler = createDespesaHandler(deps({ bling, store }));

    const { status, corpo } = await enviar(handler, corpoValido({ chaveIdempotencia: CHAVE }));

    expect(status).toBe(400);
    expect(corpo.operacao?.estado).toBe('nao_enviada');
    expect(bling.posts).toHaveLength(0);
  });

  it('recusa definitiva: recusada, e repetir a mesma operação não reenvia', async () => {
    const bling = fakeBling({ falhaCriar: 'contato.id inválido' });
    const store = fakeStore();
    const handler = createDespesaHandler(deps({ bling, store }));

    const primeira = await enviar(handler, corpoValido({ chaveIdempotencia: CHAVE }));
    const repeticao = await enviar(handler, corpoValido({ chaveIdempotencia: CHAVE }));

    expect(primeira.corpo.operacao).toEqual({ ref: CHAVE, estado: 'recusada' });
    expect(repeticao.status).toBe(400);
    expect(repeticao.corpo.operacao?.estado).toBe('recusada');
    expect(bling.posts).toHaveLength(1);
  });
});

describe('PRE-001 — identidade e digest', () => {
  it('mesma chave + mesmo payload, depois de confirmada: devolve sucesso sem um segundo POST', async () => {
    const bling = fakeBling();
    const store = fakeStore();
    const handler = createDespesaHandler(deps({ bling, store }));

    await enviar(handler, corpoValido({ chaveIdempotencia: CHAVE }));
    const repeticao = await enviar(handler, corpoValido({ chaveIdempotencia: CHAVE }));

    expect(repeticao.status).toBe(200);
    expect(repeticao.corpo.operacao).toEqual({ ref: CHAVE, estado: 'confirmada' });
    expect(bling.contasCriadasNoBling()).toBe(1);
    expect(store.salvos).toHaveLength(1);
  });

  it('mesma chave + payload diferente: 409, sem POST e sem devolver nada da outra operação', async () => {
    const bling = fakeBling();
    const store = fakeStore();
    const handler = createDespesaHandler(deps({ bling, store }));

    await enviar(handler, corpoValido({ chaveIdempotencia: CHAVE }));
    const conflito = await enviar(handler, corpoValido({ chaveIdempotencia: CHAVE, valor: 1300 }));

    expect(conflito.status).toBe(409);
    expect(conflito.corpo.data).toBeUndefined();
    expect(conflito.corpo.operacao).toBeUndefined();
    expect(bling.posts).toHaveLength(1);
  });

  it('o título local também faz parte da operação: mudar só ele com a mesma chave é conflito', async () => {
    const handler = createDespesaHandler(deps());

    await enviar(handler, corpoValido({ chaveIdempotencia: CHAVE, titulo: 'Aluguel' }));
    const conflito = await enviar(handler, corpoValido({ chaveIdempotencia: CHAVE, titulo: 'Outro' }));

    expect(conflito.status).toBe(409);
  });
});

describe('PRE-001 — concorrência', () => {
  it('duplo clique concorrente com a mesma chave: um único POST', async () => {
    let liberar: () => void = () => {};
    const segurar = new Promise<void>((resolve) => { liberar = resolve; });
    const bling = fakeBling({ segurarResposta: segurar });
    const handler = createDespesaHandler(deps({ bling }));
    const corpo = corpoValido({ chaveIdempotencia: CHAVE });

    const primeiro = enviar(handler, corpo);
    const segundo = enviar(handler, corpo);
    const segundoResultado = await segundo;
    liberar();
    const primeiroResultado = await primeiro;

    expect(segundoResultado.status).toBe(202);
    expect(segundoResultado.corpo.operacao).toEqual({ ref: CHAVE, estado: 'em_voo' });
    expect(primeiroResultado.status).toBe(200);
    expect(bling.contasCriadasNoBling()).toBe(1);
  });
});

describe('PRE-001 — crash e recuperação', () => {
  it('requisição morre depois de reivindicar (em_voo para sempre): repetir não reenvia', async () => {
    const bling = fakeBling();
    const store = fakeStore();
    // A primeira requisição reivindica e morre no meio do POST: nunca responde.
    const morta = createDespesaHandler(deps({ bling: fakeBling({ segurarResposta: new Promise(() => {}) }), store }));
    void enviar(morta, corpoValido({ chaveIdempotencia: CHAVE }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const handler = createDespesaHandler(deps({ bling, store }));
    const repeticao = await enviar(handler, corpoValido({ chaveIdempotencia: CHAVE }));

    expect(store.tentativa(ORG, CHAVE)?.estado).toBe('em_voo');
    expect(repeticao.status).toBe(202);
    expect(repeticao.corpo.operacao).toEqual({ ref: CHAVE, estado: 'em_voo' });
    expect(bling.posts).toHaveLength(0);
  });

  it('Bling confirmou mas o ORBITA não gravou o desfecho: não quita, não grava título, e bloqueia o reenvio', async () => {
    const bling = fakeBling();
    const store = fakeStore({ concluirFalha: true });
    const handler = createDespesaHandler(deps({ bling, store }));

    const { status, corpo } = await enviar(handler, corpoValido({ chaveIdempotencia: CHAVE, pago: true }));
    await enviar(handler, corpoValido({ chaveIdempotencia: CHAVE, pago: true }));

    expect(status).toBe(202);
    expect(corpo.error).toContain('88123');
    expect(store.tentativa(ORG, CHAVE)?.estado).toBe('em_voo');
    expect(bling.baixadas).toHaveLength(0);
    expect(store.salvos).toHaveLength(0);
    expect(bling.contasCriadasNoBling()).toBe(1);
  });

  it('confirmada no Bling e título não gravado: a repetição grava só o título, sem POST e sem quitar de novo', async () => {
    const bling = fakeBling();
    const store = fakeStore({ falhasDeTitulo: 1 });
    const handler = createDespesaHandler(deps({ bling, store }));
    const corpo = corpoValido({ chaveIdempotencia: CHAVE, pago: true });

    const primeira = await enviar(handler, corpo);
    const repeticao = await enviar(handler, corpo);

    expect(primeira.status).toBe(500);
    expect(primeira.corpo.operacao).toEqual({ ref: CHAVE, estado: 'confirmada' });
    expect(repeticao.status).toBe(200);
    expect(store.salvos).toEqual([expect.objectContaining({ blingId: '88123', situacao: 'aberto' })]);
    expect(store.tentativa(ORG, CHAVE)?.tituloId).toBe('titulo-1');
    expect(bling.contasCriadasNoBling()).toBe(1);
    expect(bling.baixadas).toHaveLength(1);
    expect(repeticao.corpo.avisos?.join(' ')).toContain('quitação não foi confirmada');
  });
});

describe('PRE-001 — organização e capacidade', () => {
  it('a mesma chave em outra organização é outra operação, e não vê nada da primeira', async () => {
    const bling = fakeBling({ modo: 'perde-ack' });
    const store = fakeStore();
    await enviar(createDespesaHandler(deps({ bling, store })), corpoValido({ chaveIdempotencia: CHAVE }));

    const blingB = fakeBling();
    const handlerB = createDespesaHandler(deps({
      bling: blingB,
      store,
      auth: { async authorize() { return { _tag: 'Authorized', scope: scopeB }; } },
    }));
    const deB = await enviar(handlerB, corpoValido({ chaveIdempotencia: CHAVE }));

    expect(deB.status).toBe(200);
    expect(store.tentativa(ORG, CHAVE)?.estado).toBe('indeterminada');
    expect(store.tentativa(ORG_B, CHAVE)?.estado).toBe('confirmada');
    expect(blingB.contasCriadasNoBling()).toBe(1);
  });

  it('a organização vem do escopo verificado: um organizacao_id no corpo não muda de quem é a tentativa', async () => {
    const store = fakeStore();
    const handler = createDespesaHandler(deps({ store }));

    await enviar(handler, { ...corpoValido({ chaveIdempotencia: CHAVE }), organizacao_id: ORG_B });

    expect(store.tentativa(ORG, CHAVE)).toBeDefined();
    expect(store.tentativa(ORG_B, CHAVE)).toBeUndefined();
  });

  it('membro sem capacidade: negado antes de registrar intenção ou chamar o Bling', async () => {
    const bling = fakeBling();
    const store = fakeStore();
    const handler = createDespesaHandler(deps({
      bling,
      store,
      auth: {
        async authorize() {
          return {
            _tag: 'Denied',
            response: NextResponse.json({ success: false, error: 'Capacidade insuficiente para lançar despesas' }, { status: 403 }),
          };
        },
      },
    }));

    const resposta = await handler(requisicao(corpoValido({ chaveIdempotencia: CHAVE })));

    expect(resposta.status).toBe(403);
    expect(store.tentativas).toHaveLength(0);
    expect(bling.posts).toHaveLength(0);
  });
});
