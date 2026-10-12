import { describe, expect, it } from 'vitest';
import { NextResponse } from 'next/server';

import {
  createDespesaHandler,
  type DespesaDependencies,
  type DespesaResponseBody,
} from './despesaHandler';
import { fakeBling } from './__testkit__/blingContasPagarFake';
import { depsDeTeste, fakeStore } from './__testkit__/despesaFakes';
import { buildDespesaRequest, despesaRequestSchema } from '@/lib/config/despesaContract';
import { parseBlingFailure } from '@/lib/integrations/bling/pedidoVendaContract';
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

function deps(overrides: Partial<DespesaDependencies> = {}): DespesaDependencies {
  return depsDeTeste(scope, overrides);
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
    descricao: 'Aluguel', valor: 1200, dataVencimento: '2026-09-10', categoriaId: CATEGORIA, chaveIdempotencia: CHAVE, ...overrides,
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
    expect(corpo.error).toContain('recusou os dados');
    expect(corpo.error).not.toContain('contato.id inválido');
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

  it('contábil sem chave (bundle antigo): 400 antes de qualquer efeito — o servidor não inventa chave', async () => {
    const bling = fakeBling();
    const store = fakeStore();
    const handler = createDespesaHandler(deps({ bling, store }));

    const { status, corpo } = await enviar(handler, corpoValido({ chaveIdempotencia: undefined }));

    expect(status).toBe(400);
    expect(corpo.error).toContain('chave da operação');
    expect(corpo.operacao).toBeUndefined();
    expect(store.tentativas).toHaveLength(0);
    expect(bling.contatosResolvidos()).toBe(0);
    expect(bling.posts).toHaveLength(0);
    expect(bling.contasCriadasNoBling()).toBe(0);
  });

  it('interno sem chave continua válido: não há efeito externo a proteger', async () => {
    const store = fakeStore();
    const handler = createDespesaHandler(deps({ store }));

    const { status } = await enviar(handler, corpoValido({ modo: 'interno', chaveIdempotencia: undefined }));

    expect(status).toBe(200);
    expect(store.salvos).toHaveLength(1);
    expect(store.tentativas).toHaveLength(0);
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

// ---------------------------------------------------------------------------
// Texto do provedor nunca vai à resposta pública (CWE-209).
// ---------------------------------------------------------------------------

describe('PRE-001 — mensagem do Bling na resposta', () => {
  const HOSTIL = ['<html', 'proxy-interno.bling.local', '10.0.0.5', 'sk_live_FICTICIO', 'Authorization'];
  // Corpo que o Bling (ou um proxy na frente dele) poderia devolver: envelope
  // v3 válido, com texto hostil em `description` e `fields`, que é exatamente o
  // que `parseBlingFailure` copia para `message`.
  const recusaHostil = parseBlingFailure(400, JSON.stringify({
    error: {
      type: 'VALIDATION_ERROR',
      message: 'Não foi possível salvar',
      description: '<html><body>proxy-interno.bling.local 10.0.0.5 Authorization: Bearer sk_live_FICTICIO</body></html>',
      fields: [{ code: 1, msg: 'token=sk_live_FICTICIO host 10.0.0.5', element: 'contato' }],
    },
  }));
  const corpoCruHostil = parseBlingFailure(502, '<html>proxy-interno.bling.local 10.0.0.5 sk_live_FICTICIO</html>');

  function semTextoHostil(corpo: DespesaResponseBody) {
    const publico = JSON.stringify(corpo);
    for (const trecho of HOSTIL) expect(publico).not.toContain(trecho);
  }

  it('a premissa vale: o parser coloca o texto hostil em `message`', () => {
    expect(recusaHostil.message).toContain('sk_live_FICTICIO');
    expect(corpoCruHostil.message).toContain('10.0.0.5');
  });

  it('recusa definitiva: frase do ORBITA, com status, sem o corpo do provedor', async () => {
    const bling = fakeBling({ falhaCriar: recusaHostil });
    const store = fakeStore();
    const { status, corpo } = await enviar(createDespesaHandler(deps({ bling, store })), corpoValido());

    expect(status).toBe(400);
    expect(corpo.operacao?.estado).toBe('recusada');
    expect(corpo.error).toBe(
      'O Bling recusou os dados para criar a conta a pagar (HTTP 400). Confira fornecedor, categoria, valor e vencimento.',
    );
    expect(store.tentativa(ORG, CHAVE)?.estado).toBe('recusada');
    semTextoHostil(corpo);
  });

  it('fornecedor padrão não resolvido', async () => {
    const { corpo } = await enviar(
      createDespesaHandler(deps({ bling: fakeBling({ falhaContato: corpoCruHostil }) })),
      corpoValido(),
    );

    expect(corpo.operacao?.estado).toBe('nao_enviada');
    semTextoHostil(corpo);
  });

  it('conta financeira para quitar e quitação recusada ou sem resposta', async () => {
    for (const bling of [
      fakeBling({ falhaPortador: corpoCruHostil }),
      fakeBling({ falhaBaixa: recusaHostil }),
      fakeBling({ falhaBaixa: corpoCruHostil }),
    ]) {
      const { status, corpo } = await enviar(createDespesaHandler(deps({ bling })), corpoValido({ pago: true }));

      expect(status).toBe(200);
      expect(corpo.avisos?.length).toBe(1);
      semTextoHostil(corpo);
    }
  });

  it('falha ao gravar o título: a causa do banco vai para o log, não para a resposta', async () => {
    const erroDoBanco = new Error('duplicate key value violates unique constraint "x" DETAIL: Key (bling_id)=(88123) already exists');
    const { status, corpo } = await enviar(
      createDespesaHandler(deps({ store: fakeStore({ erro: erroDoBanco }) })),
      corpoValido(),
    );

    expect(status).toBe(500);
    expect(JSON.stringify(corpo)).not.toContain('DETAIL');
    expect(JSON.stringify(corpo)).not.toContain('duplicate key');
  });
});
