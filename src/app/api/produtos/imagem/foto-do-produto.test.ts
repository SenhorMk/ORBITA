import { NextResponse } from 'next/server';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  createAutorizarUploadHandler,
  createConfirmarUploadHandler,
  createRemoverImagemHandler,
  type EventoDaFoto,
  type FotoDoProdutoDependencies,
} from './handler';
import { validateAuditEventMetadata } from '@/lib/observability/auditEventCatalog';
import type { ArmazenamentoDeImagemPort } from '@/services/armazenamentoDeImagem';
import type { ProdutoComFoto } from '@/repositories/produtoImagemRepository';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';

const ORG = '11111111-1111-4111-8111-111111111111';
const OUTRA_ORG = '99999999-9999-4999-8999-999999999999';
const ATOR = '22222222-2222-4222-8222-222222222222';
const PRODUTO = '33333333-3333-4333-8333-333333333333';
const OUTRO_PRODUTO = '44444444-4444-4444-8444-444444444444';
const PRODUTO_DE_OUTRA_ORG = '55555555-5555-4555-8555-555555555555';
const OBJ_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OBJ_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OBJ_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const caminho = (obj: string, ext = 'png', org = ORG, produto = PRODUTO) => `${org}/${produto}/${obj}.${ext}`;
const FOTO_A = caminho(OBJ_A);
const FOTO_B = caminho(OBJ_B);
const FOTO_C = caminho(OBJ_C);
const BLING = 'https://orgbling.s3.amazonaws.com/produto.jpg';

/** SAFETY: o escopo é entrada do teste, não o que está sob teste — convenção dos demais testes de rota. */
const scope = { organizationId: ORG, actorId: ATOR, role: 'owner' } as unknown as VerifiedOrganizationScope;

interface Linha { id: string; organizacaoId: string; imagemStoragePath: string | null; imagemDoBling: string | null }

/**
 * Banco em memória com linhas de DUAS organizações. O fake aplica o filtro por
 * organização e a precondição do compare-and-set de verdade, como o `UPDATE`
 * do repositório — então os testes provam o que a consulta encontra.
 */
function fakeStore(linhas: Linha[]) {
  const trocas: Array<{ organizacaoId: string; produtoId: string; anterior: string | null; novo: string | null }> = [];
  let antesDaTroca: (() => void) | null = null;
  return {
    linhas,
    trocas,
    /** Simula outra aba commitando entre a leitura e o compare-and-set desta. */
    intercalar(acao: () => void) { antesDaTroca = acao; },
    async carregar(escopo: VerifiedOrganizationScope, produtoId: string): Promise<ProdutoComFoto | null> {
      const linha = linhas.find((l) => l.id === produtoId && l.organizacaoId === escopo.organizationId);
      return linha ? { id: linha.id, imagemStoragePath: linha.imagemStoragePath, imagemDoBling: linha.imagemDoBling } : null;
    },
    async trocarCaminho(escopo: VerifiedOrganizationScope, produtoId: string, anterior: string | null, novo: string | null) {
      antesDaTroca?.();
      antesDaTroca = null;
      trocas.push({ organizacaoId: escopo.organizationId, produtoId, anterior, novo });
      const linha = linhas.find((l) => l.id === produtoId && l.organizacaoId === escopo.organizationId);
      if (!linha || linha.imagemStoragePath !== anterior) return false;
      linha.imagemStoragePath = novo;
      return true;
    },
  };
}

function fakeArmazenamento(opcoes: {
  objetos?: Record<string, { tamanho: number | null; tipo: string | null }>;
  indisponivel?: boolean;
  falharRemocao?: boolean;
  falharAssinatura?: boolean;
} = {}) {
  const objetos = { ...(opcoes.objetos ?? {}) };
  const uploadsAutorizados: string[] = [];
  const removidos: string[] = [];
  const porta: ArmazenamentoDeImagemPort = {
    async autorizarUpload(c) {
      if (opcoes.indisponivel) return { _tag: 'Indisponivel', causa: new Error('storage fora: detalhe interno SECRETO') };
      uploadsAutorizados.push(c);
      return { _tag: 'Autorizado', token: `token-para-${c}` };
    },
    async inspecionar(c) {
      if (opcoes.indisponivel) return { _tag: 'Indisponivel', causa: new Error('fora') };
      const objeto = objetos[c];
      return objeto ? { _tag: 'Presente', ...objeto } : { _tag: 'Ausente' };
    },
    async remover(caminhos) {
      if (opcoes.falharRemocao) return { _tag: 'Falhou', causa: new Error('remove falhou') };
      for (const c of caminhos) { removidos.push(c); delete objetos[c]; }
      return { _tag: 'Removido' };
    },
    async assinarLeituras(caminhos) {
      if (opcoes.falharAssinatura) return { _tag: 'Indisponivel', causa: new Error('sign fora') };
      return { _tag: 'Assinadas', urls: new Map(caminhos.map((c) => [c, `https://storage.test/sign/${c}?token=leitura`])) };
    },
  };
  return { porta, objetos, uploadsAutorizados, removidos };
}

let store: ReturnType<typeof fakeStore>;
let armazenamento: ReturnType<typeof fakeArmazenamento>;
let auditados: EventoDaFoto[];
let proximoId: string;

function deps(overrides: Partial<FotoDoProdutoDependencies> = {}): FotoDoProdutoDependencies {
  return {
    autorizar: async () => ({ _tag: 'Autorizado', scope }),
    store,
    armazenamento: armazenamento.porta,
    auditar: async (_escopo, evento) => { auditados.push(evento); },
    correlationId: () => 'corr-teste',
    novoId: () => proximoId,
    ...overrides,
  };
}

function post(corpo: unknown): Request {
  return new Request('https://orbita.test/api/produtos/imagem', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(corpo),
  });
}

async function chamar(handler: (r: Request) => Promise<NextResponse>, corpo: unknown) {
  const resposta = await handler(post(corpo));
  return { status: resposta.status, corpo: await resposta.json() as Record<string, unknown> };
}

const upload = (corpo: unknown, d = deps()) => chamar(createAutorizarUploadHandler(d), corpo);
const confirmar = (corpo: unknown, d = deps()) => chamar(createConfirmarUploadHandler(d), corpo);
const remover = (corpo: unknown, d = deps()) => chamar(createRemoverImagemHandler(d), corpo);

const PNG_OK = { tamanho: 1024, tipo: 'image/png' };

beforeEach(() => {
  store = fakeStore([
    { id: PRODUTO, organizacaoId: ORG, imagemStoragePath: null, imagemDoBling: BLING },
    { id: OUTRO_PRODUTO, organizacaoId: ORG, imagemStoragePath: null, imagemDoBling: null },
    { id: PRODUTO_DE_OUTRA_ORG, organizacaoId: OUTRA_ORG, imagemStoragePath: caminho(OBJ_A, 'png', OUTRA_ORG, PRODUTO_DE_OUTRA_ORG), imagemDoBling: null },
  ]);
  armazenamento = fakeArmazenamento();
  auditados = [];
  proximoId = OBJ_B;
});

describe('autorização — ninguém chega ao produto nem ao Storage sem organization:manage', () => {
  const negar = (status: 401 | 403) => deps({
    autorizar: async () => ({ _tag: 'Negado', response: NextResponse.json({ success: false }, { status }) }),
  });

  it.each([
    ['sem sessão', 401],
    ['sem organization:manage', 403],
  ] as const)('%s: %i nas três rotas, sem ler produto nem emitir token', async (_caso, status) => {
    const d = negar(status);
    expect((await upload({ produtoId: PRODUTO, tipo: 'image/png', tamanho: 10 }, d)).status).toBe(status);
    expect((await confirmar({ produtoId: PRODUTO, caminho: FOTO_B, anterior: null }, d)).status).toBe(status);
    expect((await remover({ produtoId: PRODUTO, anterior: FOTO_A }, d)).status).toBe(status);
    expect(armazenamento.uploadsAutorizados).toEqual([]);
    expect(store.trocas).toEqual([]);
    expect(armazenamento.removidos).toEqual([]);
  });
});

describe('etapa A — autorizar upload', () => {
  it('gera o caminho no servidor: organização do escopo, produto relido, uuid e extensão pelo tipo', async () => {
    const r = await upload({ produtoId: PRODUTO, tipo: 'image/webp', tamanho: 2048 });
    expect(r.status).toBe(200);
    expect(r.corpo).toEqual({ resultado: 'UploadAutorizado', caminho: caminho(OBJ_B, 'webp'), token: `token-para-${caminho(OBJ_B, 'webp')}` });
    expect(armazenamento.uploadsAutorizados).toEqual([caminho(OBJ_B, 'webp')]);
  });

  it('ignora organizationId, organizacao_id e caminho mandados pelo navegador', async () => {
    const r = await upload({
      produtoId: PRODUTO, tipo: 'image/jpeg', tamanho: 10,
      organizationId: OUTRA_ORG, organizacao_id: OUTRA_ORG,
      caminho: `${OUTRA_ORG}/${PRODUTO_DE_OUTRA_ORG}/x.jpg`, path: '../../segredo',
    });
    expect(r.corpo.caminho).toBe(caminho(OBJ_B, 'jpg'));
    expect(armazenamento.uploadsAutorizados).toEqual([caminho(OBJ_B, 'jpg')]);
  });

  it('produto de outra organização responde igual a produto inexistente, sem token', async () => {
    const outro = await upload({ produtoId: PRODUTO_DE_OUTRA_ORG, tipo: 'image/png', tamanho: 10 });
    const inexistente = await upload({ produtoId: '77777777-7777-4777-8777-777777777777', tipo: 'image/png', tamanho: 10 });
    expect(outro).toEqual({ status: 404, corpo: { resultado: 'ProdutoNaoEncontrado' } });
    expect(inexistente).toEqual(outro);
    expect(armazenamento.uploadsAutorizados).toEqual([]);
  });

  it.each(['image/gif', 'image/svg+xml', 'application/pdf', 'text/html'])('recusa o tipo %s com 415', async (tipo) => {
    expect(await upload({ produtoId: PRODUTO, tipo, tamanho: 10 })).toEqual({ status: 415, corpo: { resultado: 'TipoNaoPermitido' } });
    expect(armazenamento.uploadsAutorizados).toEqual([]);
  });

  it('recusa acima de 5 MB com 413, e aceita exatamente 5 MB', async () => {
    expect(await upload({ produtoId: PRODUTO, tipo: 'image/png', tamanho: 5 * 1024 * 1024 + 1 }))
      .toEqual({ status: 413, corpo: { resultado: 'ArquivoGrandeDemais' } });
    expect((await upload({ produtoId: PRODUTO, tipo: 'image/png', tamanho: 5 * 1024 * 1024 })).status).toBe(200);
  });

  it('corpo inválido (sem produtoId, id que não é uuid, JSON quebrado) é 400', async () => {
    expect((await upload({ tipo: 'image/png', tamanho: 10 })).status).toBe(400);
    expect((await upload({ produtoId: 'LOCAL-1', tipo: 'image/png', tamanho: 10 })).status).toBe(400);
    const quebrado = await createAutorizarUploadHandler(deps())(new Request('https://orbita.test', { method: 'POST', body: '{' }));
    expect(quebrado.status).toBe(400);
  });

  it('Storage indisponível vira 503 com resultado público, sem ecoar o erro', async () => {
    armazenamento = fakeArmazenamento({ indisponivel: true });
    const r = await upload({ produtoId: PRODUTO, tipo: 'image/png', tamanho: 10 });
    expect(r).toEqual({ status: 503, corpo: { resultado: 'ArmazenamentoIndisponivel' } });
    expect(JSON.stringify(r.corpo)).not.toContain('SECRETO');
  });
});

describe('etapa C — confirmar upload', () => {
  it('adiciona: confere o objeto, grava o caminho só no produto da organização e devolve URL assinada', async () => {
    armazenamento.objetos[FOTO_B] = PNG_OK;
    const r = await confirmar({ produtoId: PRODUTO, caminho: FOTO_B, anterior: null });
    expect(r.status).toBe(200);
    expect(r.corpo).toMatchObject({ resultado: 'ImagemConfirmada', caminho: FOTO_B });
    expect(String(r.corpo.url)).toContain('https://storage.test/sign/');
    expect(store.trocas).toEqual([{ organizacaoId: ORG, produtoId: PRODUTO, anterior: null, novo: FOTO_B }]);
    expect(store.linhas.find((l) => l.id === PRODUTO)?.imagemStoragePath).toBe(FOTO_B);
    expect(store.linhas.find((l) => l.id === PRODUTO)?.imagemDoBling).toBe(BLING);
    expect(armazenamento.removidos).toEqual([]);
  });

  it('upload que não aconteceu: 422, nada gravado — "terminou" dito pelo navegador não é prova', async () => {
    expect(await confirmar({ produtoId: PRODUTO, caminho: FOTO_B, anterior: null }))
      .toEqual({ status: 422, corpo: { resultado: 'UploadAusente' } });
    expect(store.trocas).toEqual([]);
  });

  it.each([
    ['de outra organização', caminho(OBJ_B, 'png', OUTRA_ORG, PRODUTO_DE_OUTRA_ORG)],
    ['de outro produto da mesma organização', caminho(OBJ_B, 'png', ORG, OUTRO_PRODUTO)],
    ['com travessia de diretório', `${ORG}/${PRODUTO}/../${OUTRO_PRODUTO}/${OBJ_B}.png`],
    ['com extensão fora da lista', caminho(OBJ_B, 'svg')],
    ['sem uuid', `${ORG}/${PRODUTO}/foto.png`],
  ])('caminho adulterado %s: 400, sem gravar nem apagar', async (_caso, adulterado) => {
    armazenamento.objetos[adulterado] = PNG_OK;
    expect(await confirmar({ produtoId: PRODUTO, caminho: adulterado, anterior: null }))
      .toEqual({ status: 400, corpo: { resultado: 'CaminhoInvalido' } });
    expect(store.trocas).toEqual([]);
    expect(armazenamento.removidos).toEqual([]);
  });

  it('precondição fora do prefixo também é recusada — nunca vira alvo de remoção', async () => {
    armazenamento.objetos[FOTO_B] = PNG_OK;
    const alheio = caminho(OBJ_A, 'png', OUTRA_ORG, PRODUTO_DE_OUTRA_ORG);
    expect((await confirmar({ produtoId: PRODUTO, caminho: FOTO_B, anterior: alheio })).status).toBe(400);
    expect(armazenamento.removidos).toEqual([]);
  });

  it('precondição igual ao caminho novo é recusada — a limpeza nunca pode mirar a foto recém-gravada', async () => {
    armazenamento.objetos[FOTO_B] = PNG_OK;
    store.linhas[0]!.imagemStoragePath = FOTO_A;
    expect((await confirmar({ produtoId: PRODUTO, caminho: FOTO_B, anterior: FOTO_B })).corpo).toEqual({ resultado: 'CaminhoInvalido' });
    expect(store.trocas).toEqual([]);
    expect(armazenamento.removidos).toEqual([]);
  });

  it('produto de outra organização: 404, mesmo com caminho no prefixo dele', async () => {
    const dele = caminho(OBJ_B, 'png', OUTRA_ORG, PRODUTO_DE_OUTRA_ORG);
    armazenamento.objetos[dele] = PNG_OK;
    expect((await confirmar({ produtoId: PRODUTO_DE_OUTRA_ORG, caminho: dele, anterior: null })).status).toBe(404);
    expect(store.linhas.find((l) => l.id === PRODUTO_DE_OUTRA_ORG)?.imagemStoragePath).toBe(caminho(OBJ_A, 'png', OUTRA_ORG, PRODUTO_DE_OUTRA_ORG));
  });

  it('objeto acima de 5 MB ou com tipo diferente do prometido é recusado e removido', async () => {
    armazenamento.objetos[FOTO_B] = { tamanho: 6 * 1024 * 1024, tipo: 'image/png' };
    expect((await confirmar({ produtoId: PRODUTO, caminho: FOTO_B, anterior: null })).corpo).toEqual({ resultado: 'ArquivoGrandeDemais' });
    armazenamento.objetos[FOTO_C] = { tamanho: 10, tipo: 'text/html' };
    expect((await confirmar({ produtoId: PRODUTO, caminho: FOTO_C, anterior: null })).corpo).toEqual({ resultado: 'TipoNaoPermitido' });
    expect(armazenamento.removidos).toEqual([FOTO_B, FOTO_C]);
    expect(store.trocas).toEqual([]);
  });

  it('troca: CAS para o novo caminho e SÓ DEPOIS remove a foto anterior', async () => {
    store.linhas[0]!.imagemStoragePath = FOTO_A;
    armazenamento.objetos[FOTO_A] = PNG_OK;
    armazenamento.objetos[FOTO_B] = PNG_OK;
    let removidoAntesDoCas = false;
    store.intercalar(() => { removidoAntesDoCas = armazenamento.removidos.length > 0; });

    const r = await confirmar({ produtoId: PRODUTO, caminho: FOTO_B, anterior: FOTO_A });
    expect(r.status).toBe(200);
    expect(removidoAntesDoCas).toBe(false);
    expect(store.linhas[0]!.imagemStoragePath).toBe(FOTO_B);
    expect(armazenamento.removidos).toEqual([FOTO_A]);
    expect(auditados[0]?.metadata).toEqual({ produto_id: PRODUTO, substituiu_anterior: true, limpeza_anterior: 'concluida' });
  });

  it('falha na limpeza da foto anterior não desfaz a troca, e fica registrada na auditoria', async () => {
    store.linhas[0]!.imagemStoragePath = FOTO_A;
    armazenamento = fakeArmazenamento({ objetos: { [FOTO_A]: PNG_OK, [FOTO_B]: PNG_OK }, falharRemocao: true });
    const r = await confirmar({ produtoId: PRODUTO, caminho: FOTO_B, anterior: FOTO_A });
    expect(r.status).toBe(200);
    expect(r.corpo.resultado).toBe('ImagemConfirmada');
    expect(store.linhas[0]!.imagemStoragePath).toBe(FOTO_B);
    expect(auditados[0]?.metadata.limpeza_anterior).toBe('falhou');
  });

  it('duas abas trocando a partir da MESMA foto: uma vence, a outra recebe 409 e o objeto dela sai', async () => {
    store.linhas[0]!.imagemStoragePath = FOTO_A;
    armazenamento.objetos[FOTO_A] = PNG_OK;
    armazenamento.objetos[FOTO_B] = PNG_OK;
    armazenamento.objetos[FOTO_C] = PNG_OK;

    const aba1 = await confirmar({ produtoId: PRODUTO, caminho: FOTO_B, anterior: FOTO_A });
    const aba2 = await confirmar({ produtoId: PRODUTO, caminho: FOTO_C, anterior: FOTO_A });

    expect(aba1.corpo.resultado).toBe('ImagemConfirmada');
    expect(aba2).toEqual({ status: 409, corpo: { resultado: 'Conflito' } });
    expect(store.linhas[0]!.imagemStoragePath).toBe(FOTO_B);
    // A foto vencedora continua no Storage; saíram a substituída e a perdedora.
    expect(armazenamento.removidos).toEqual([FOTO_A, FOTO_C]);
    expect(armazenamento.objetos[FOTO_B]).toBeDefined();
    expect(auditados).toHaveLength(1);
  });

  it('corrida intercalada: outra aba commita entre a releitura e o CAS desta — conflito, sem sobrescrever', async () => {
    store.linhas[0]!.imagemStoragePath = FOTO_A;
    armazenamento.objetos[FOTO_C] = PNG_OK;
    store.intercalar(() => { store.linhas[0]!.imagemStoragePath = FOTO_B; });
    expect((await confirmar({ produtoId: PRODUTO, caminho: FOTO_C, anterior: FOTO_A })).status).toBe(409);
    expect(store.linhas[0]!.imagemStoragePath).toBe(FOTO_B);
    expect(armazenamento.removidos).toEqual([FOTO_C]);
  });

  it('confirmação repetida (duplo envio) é idempotente e não apaga a foto que acabou de valer', async () => {
    armazenamento.objetos[FOTO_B] = PNG_OK;
    await confirmar({ produtoId: PRODUTO, caminho: FOTO_B, anterior: null });
    const repetida = await confirmar({ produtoId: PRODUTO, caminho: FOTO_B, anterior: null });
    expect(repetida.corpo.resultado).toBe('ImagemConfirmada');
    expect(armazenamento.removidos).toEqual([]);
    expect(store.linhas[0]!.imagemStoragePath).toBe(FOTO_B);
  });

  it('assinatura falha depois do CAS: a foto continua confirmada e a tela recebe a imagem do Bling', async () => {
    armazenamento = fakeArmazenamento({ objetos: { [FOTO_B]: PNG_OK }, falharAssinatura: true });
    const r = await confirmar({ produtoId: PRODUTO, caminho: FOTO_B, anterior: null });
    expect(r).toEqual({ status: 200, corpo: { resultado: 'ImagemConfirmada', caminho: FOTO_B, url: BLING } });
    expect(store.linhas[0]!.imagemStoragePath).toBe(FOTO_B);
    expect(auditados).toHaveLength(1);
  });

  it('assinatura falha e não há imagem do Bling: url null (placeholder), sem desfazer a confirmação', async () => {
    store.linhas[0]!.imagemDoBling = null;
    armazenamento = fakeArmazenamento({ objetos: { [FOTO_B]: PNG_OK }, falharAssinatura: true });
    const r = await confirmar({ produtoId: PRODUTO, caminho: FOTO_B, anterior: null });
    expect(r.corpo).toEqual({ resultado: 'ImagemConfirmada', caminho: FOTO_B, url: null });
    expect(store.linhas[0]!.imagemStoragePath).toBe(FOTO_B);
  });

  it('confirmação concorrente da MESMA foto com assinatura falha: o fallback usa a releitura, não a imagem do Bling antiga', async () => {
    armazenamento = fakeArmazenamento({ objetos: { [FOTO_B]: PNG_OK }, falharAssinatura: true });
    // Entre a primeira leitura e o CAS, outra requisição confirmou esta mesma
    // foto e a sincronização trocou a imagem do Bling.
    store.intercalar(() => {
      store.linhas[0]!.imagemStoragePath = FOTO_B;
      store.linhas[0]!.imagemDoBling = 'https://orgbling.s3.amazonaws.com/nova.jpg';
    });
    const r = await confirmar({ produtoId: PRODUTO, caminho: FOTO_B, anterior: null });
    expect(r.corpo).toEqual({ resultado: 'ImagemConfirmada', caminho: FOTO_B, url: 'https://orgbling.s3.amazonaws.com/nova.jpg' });
    expect(armazenamento.removidos).toEqual([]);
  });

  it('Storage indisponível na inspeção: 503, nada gravado', async () => {
    armazenamento = fakeArmazenamento({ indisponivel: true });
    expect(await confirmar({ produtoId: PRODUTO, caminho: FOTO_B, anterior: null }))
      .toEqual({ status: 503, corpo: { resultado: 'ArmazenamentoIndisponivel' } });
    expect(store.trocas).toEqual([]);
  });
});

describe('remoção', () => {
  beforeEach(() => {
    store.linhas[0]!.imagemStoragePath = FOTO_A;
    armazenamento.objetos[FOTO_A] = PNG_OK;
  });

  it('CAS para null, depois remove o objeto, e devolve a imagem do Bling para a tela', async () => {
    let removidoAntesDoCas = false;
    store.intercalar(() => { removidoAntesDoCas = armazenamento.removidos.length > 0; });
    expect(await remover({ produtoId: PRODUTO, anterior: FOTO_A })).toEqual({ status: 200, corpo: { resultado: 'ImagemRemovida', url: BLING } });
    expect(removidoAntesDoCas).toBe(false);
    expect(store.linhas[0]!.imagemStoragePath).toBeNull();
    // A imagem do Bling não é tocada.
    expect(store.linhas[0]!.imagemDoBling).toBe(BLING);
    expect(armazenamento.removidos).toEqual([FOTO_A]);
    expect(auditados[0]).toMatchObject({ acao: 'catalog.product_image_removed', metadata: { produto_id: PRODUTO, limpeza_anterior: 'concluida' } });
  });

  it('sem imagem do Bling, volta url null — a tela mostra o placeholder', async () => {
    store.linhas[0]!.imagemDoBling = null;
    expect((await remover({ produtoId: PRODUTO, anterior: FOTO_A })).corpo).toEqual({ resultado: 'ImagemRemovida', url: null });
  });

  it('precondição desatualizada (foto trocada em outra aba): 409, nada removido', async () => {
    store.linhas[0]!.imagemStoragePath = FOTO_B;
    expect((await remover({ produtoId: PRODUTO, anterior: FOTO_A })).status).toBe(409);
    expect(store.linhas[0]!.imagemStoragePath).toBe(FOTO_B);
    expect(armazenamento.removidos).toEqual([]);
  });

  it('remoção repetida é idempotente', async () => {
    await remover({ produtoId: PRODUTO, anterior: FOTO_A });
    expect((await remover({ produtoId: PRODUTO, anterior: FOTO_A })).corpo).toEqual({ resultado: 'ImagemRemovida', url: BLING });
    expect(armazenamento.removidos).toEqual([FOTO_A]);
  });

  it('nenhum arquivo de outro tenant é apagado — nem pedindo pelo produto dele, nem pelo caminho dele', async () => {
    const dele = caminho(OBJ_A, 'png', OUTRA_ORG, PRODUTO_DE_OUTRA_ORG);
    expect((await remover({ produtoId: PRODUTO_DE_OUTRA_ORG, anterior: dele })).status).toBe(404);
    expect((await remover({ produtoId: PRODUTO, anterior: dele })).status).toBe(400);
    expect(armazenamento.removidos).toEqual([]);
    expect(store.linhas[2]!.imagemStoragePath).toBe(dele);
  });

  it('falha na limpeza não desfaz a remoção', async () => {
    armazenamento = fakeArmazenamento({ objetos: { [FOTO_A]: PNG_OK }, falharRemocao: true });
    expect((await remover({ produtoId: PRODUTO, anterior: FOTO_A })).status).toBe(200);
    expect(store.linhas[0]!.imagemStoragePath).toBeNull();
    expect(auditados[0]?.metadata.limpeza_anterior).toBe('falhou');
  });
});

describe('toda remoção do Storage fica dentro do prefixo da organização do escopo', () => {
  it('em todos os fluxos acima de troca, conflito e recusa', async () => {
    store.linhas[0]!.imagemStoragePath = FOTO_A;
    armazenamento.objetos[FOTO_A] = PNG_OK;
    armazenamento.objetos[FOTO_B] = PNG_OK;
    armazenamento.objetos[FOTO_C] = { tamanho: 10, tipo: 'image/gif' };
    await confirmar({ produtoId: PRODUTO, caminho: FOTO_B, anterior: FOTO_A });
    await confirmar({ produtoId: PRODUTO, caminho: FOTO_C, anterior: FOTO_B });
    await remover({ produtoId: PRODUTO, anterior: FOTO_B });
    expect(armazenamento.removidos.length).toBeGreaterThan(0);
    for (const removido of armazenamento.removidos) expect(removido.startsWith(`${ORG}/${PRODUTO}/`)).toBe(true);
  });
});

describe('auditoria sem dados sensíveis', () => {
  it('só id do produto, se substituiu e o desfecho técnico — e o catálogo aceita exatamente isso', async () => {
    armazenamento.objetos[FOTO_B] = PNG_OK;
    await confirmar({ produtoId: PRODUTO, caminho: FOTO_B, anterior: null });
    await remover({ produtoId: PRODUTO, anterior: FOTO_B });

    expect(auditados.map((e) => e.acao)).toEqual(['catalog.product_image_uploaded', 'catalog.product_image_removed']);
    expect(Object.keys(auditados[0]!.metadata).sort()).toEqual(['limpeza_anterior', 'produto_id', 'substituiu_anterior']);
    expect(Object.keys(auditados[1]!.metadata).sort()).toEqual(['limpeza_anterior', 'produto_id']);
    const serializado = JSON.stringify(auditados);
    for (const proibido of ['token', 'sign', 'https://', OBJ_B, '.png']) expect(serializado).not.toContain(proibido);
    for (const evento of auditados) expect(validateAuditEventMetadata(evento.acao, { ...evento.metadata })._tag).toBe('Valid');
  });

  it('falha ao auditar não muda a resposta de um efeito já confirmado', async () => {
    armazenamento.objetos[FOTO_B] = PNG_OK;
    const r = await confirmar({ produtoId: PRODUTO, caminho: FOTO_B, anterior: null }, deps({
      auditar: async () => { throw new Error('auditoria fora'); },
    }));
    expect(r.status).toBe(200);
  });
});
