import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import crypto from 'node:crypto';

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project-ref.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'public-key-12345678901234567890';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'server-key-12345678901234567890';
process.env.ENCRYPTION_KEY = 'ab'.repeat(32);

import { encrypt } from '../../../../lib/crypto';

/**
 * PRE-004: `product.deleted` do Bling vira tombstone. O webhook passa pela
 * assinatura real (HMAC), pelo inbox idempotente e pelo repositório real até o
 * `supabaseServer`, que aqui é um banco em memória com o contrato da
 * migration 76. O comportamento do próprio banco (arquivar, preservar,
 * recusar a recriação, concorrência) é provado no pgTAP e no ensaio de
 * concorrência.
 */

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const SECRET: Record<string, string> = { [ORG_A]: 'secret-bling-org-a', [ORG_B]: 'secret-bling-org-b' };
const DONO: Record<string, string> = { [ORG_A]: 'a1a1a1a1-0000-4000-8000-0000000000a1', [ORG_B]: 'b2b2b2b2-0000-4000-8000-0000000000b2' };
const BLING_ID = '16714230397';

type EventoNoInbox = { id: string; status: string; response: Record<string, unknown> | null };
let inbox: Map<string, EventoNoInbox>;
let tombstones: Map<string, { excluidoNoBlingEm: unknown }>;
let produtosLocais: Set<string>;
let bancoCai: boolean;
/** Status de conclusão do inbox que o banco recusa (a RPC devolve erro). */
let conclusaoRecusada: Set<string>;

const chaveDe = (org: unknown, bling: unknown) => `${String(org)}:${String(bling)}`;
const eventoPorId = (id: unknown) => [...inbox.values()].find((e) => e.id === id);

const rpc = vi.fn(async (nome: string, args: Record<string, unknown>) => {
  if (nome === 'registrar_evento_inbox_bling') {
    const chave = chaveDe(args.p_organizacao_id, args.p_idempotency_key);
    const existente = inbox.get(chave);
    if (existente) {
      return { data: [{ evento_id: existente.id, status: existente.status, is_duplicate: true, cached_response: existente.response }], error: null };
    }
    const novo = { id: `evt-${inbox.size + 1}`, status: 'received', response: null };
    inbox.set(chave, novo);
    return { data: [{ evento_id: novo.id, status: novo.status, is_duplicate: false, cached_response: null }], error: null };
  }
  if (nome === 'concluir_evento_inbox_bling') {
    if (conclusaoRecusada.has(String(args.p_status))) return { data: null, error: { code: '57014', message: 'statement timeout' } };
    const evento = eventoPorId(args.p_evento_id);
    if (evento) Object.assign(evento, { status: args.p_status, response: args.p_response_body ?? null });
    return { data: null, error: null };
  }
  if (nome === 'registrar_exclusao_de_produto_no_bling') {
    // Uma transação: ou grava tudo, ou nada.
    if (bancoCai) return { data: null, error: { code: '08006', message: 'conexão com o banco recusada' } };
    const chave = chaveDe(args.p_organizacao_id, args.p_bling_id);
    if (tombstones.has(chave)) return { data: [{ desfecho: 'ja_registrado', produto_id: null }], error: null };
    tombstones.set(chave, { excluidoNoBlingEm: args.p_excluido_no_bling_em });
    const desfecho = produtosLocais.has(chave) ? 'registrado' : 'registrado_sem_produto';
    return { data: [{ desfecho, produto_id: null }], error: null };
  }
  throw new Error(`rpc inesperada: ${nome}`);
});

/** Encadeia `.eq(col, valor)` e resolve com o que `resolver` decidir pelos filtros. */
function consulta(resolver: (filtros: Record<string, unknown>) => unknown) {
  const filtros: Record<string, unknown> = {};
  const cadeia = {
    select: () => cadeia,
    eq: (col: string, valor: unknown) => { filtros[col] = valor; return cadeia; },
    limit: () => cadeia,
    maybeSingle: async () => ({ data: resolver(filtros), error: null }),
    then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: resolver(filtros), error: null }).then(ok),
  };
  return cadeia;
}

vi.mock('../../../../lib/supabaseServer', () => ({
  supabaseServer: {
    rpc: (nome: string, args: Record<string, unknown>) => rpc(nome, args),
    from: (tabela: string) => {
      if (tabela === 'conexoes_integracao') {
        return consulta(() => [
          { id: 'conexao-a', organizacao_id: ORG_A },
          { id: 'conexao-b', organizacao_id: ORG_B },
        ]);
      }
      if (tabela === 'credenciais_integracao') {
        return consulta((f) => ({
          dados_cifrados: encrypt(JSON.stringify({ client_id: 'client-id', client_secret: SECRET[String(f.organizacao_id)] })),
          chave_versao: 'v1',
        }));
      }
      if (tabela === 'membros_organizacao') {
        return consulta((f) => (f.papel ? { user_id: DONO[String(f.organizacao_id)] } : { papel: 'owner' }));
      }
      if (tabela === 'inbox_eventos_bling') {
        return consulta((f) => ([...inbox.entries()].some(([chave, e]) => e.id === f.id && chave.startsWith(`${String(f.organizacao_id)}:`))
          ? { id: f.id } : null));
      }
      if (tabela === 'produtos_excluidos_no_bling') {
        return consulta((f) => (tombstones.has(chaveDe(f.organizacao_id, f.bling_id)) ? { bling_id: f.bling_id } : null));
      }
      throw new Error(`tabela inesperada: ${tabela}`);
    },
  },
}));

const getProduto = vi.fn(async () => ({ id: Number(BLING_ID), nome: 'Do Bling', preco: 10 }));
vi.mock('../../../../services/bling', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../../services/bling')>(),
  bling: { forOrganization: () => ({ getProduto, getPedido: vi.fn() }) },
}));

const getByBlingId = vi.fn(async () => null);
const upsert = vi.fn(async (_escopo: unknown, produto: unknown) => produto);
vi.mock('../../../../repositories/produtoRepository', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../../repositories/produtoRepository')>();
  return {
    ...real,
    produtoRepository: {
      // O caminho da exclusão é o real, até o `supabaseServer`.
      registrarExclusaoNoBling: real.produtoRepository.registrarExclusaoNoBling.bind(real.produtoRepository),
      excluidoNoBling: real.produtoRepository.excluidoNoBling.bind(real.produtoRepository),
      getByBlingId,
      upsert,
    },
  };
});
vi.mock('../../../../services/espelhoDaImagemDoBling', () => ({ registrarSeDivergente: vi.fn(async () => false) }));

async function entregar(evento: unknown, org: string = ORG_A, assinatura?: string) {
  const raw = JSON.stringify(evento);
  const { POST } = await import('./route');
  return POST(new NextRequest('https://orbita.test/api/bling/webhook', {
    method: 'POST',
    headers: {
      'x-bling-signature-256': assinatura ?? `sha256=${crypto.createHmac('sha256', SECRET[org]).update(raw).digest('hex')}`,
      'content-type': 'application/json',
    },
    body: raw,
  }));
}

const exclusao = (id: unknown = BLING_ID, extra: Record<string, unknown> = {}) => ({ event: 'product.deleted', data: { id }, ...extra });
const respostaNoInbox = (org: string, chave: string) => inbox.get(chaveDe(org, chave));
const chamadasDaExclusao = () => rpc.mock.calls.filter(([nome]) => nome === 'registrar_exclusao_de_produto_no_bling');

beforeEach(() => {
  inbox = new Map();
  tombstones = new Map();
  produtosLocais = new Set([chaveDe(ORG_A, BLING_ID), chaveDe(ORG_B, BLING_ID)]);
  bancoCai = false;
  conclusaoRecusada = new Set();
  rpc.mockClear();
  getProduto.mockClear();
  getByBlingId.mockClear();
  upsert.mockClear();
});

describe('webhook: product.deleted vira tombstone (PRE-004)', () => {
  it('payload mínimo: registra a exclusão sem GET de detalhe nem upsert', async () => {
    const resposta = await entregar({ ...exclusao(Number(BLING_ID)), date: '2026-10-12T10:00:00Z' });

    expect(resposta.status).toBe(200);
    expect(chamadasDaExclusao()).toEqual([['registrar_exclusao_de_produto_no_bling', {
      p_organizacao_id: ORG_A, p_bling_id: BLING_ID, p_excluido_no_bling_em: '2026-10-12T10:00:00.000Z',
    }]]);
    expect(getProduto).not.toHaveBeenCalled();
    expect(getByBlingId).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(respostaNoInbox(ORG_A, `product.deleted_${BLING_ID}`)).toMatchObject({
      status: 'processed',
      response: { success: true, entity: 'produto', acao: 'excluido_no_bling', blingId: BLING_ID, desfecho: 'registrado' },
    });
  });

  it('assinatura inválida: 403 e nenhum efeito', async () => {
    const resposta = await entregar(exclusao(), ORG_A, 'sha256=forjada');

    expect(resposta.status).toBe(403);
    expect(inbox.size).toBe(0);
    expect(tombstones.size).toBe(0);
  });

  it('produto que o ORBITA nunca teve: tombstone sem produto, evento concluído', async () => {
    const resposta = await entregar(exclusao('99999999901'));

    expect(resposta.status).toBe(200);
    expect(tombstones.has(chaveDe(ORG_A, '99999999901'))).toBe(true);
    expect(respostaNoInbox(ORG_A, 'product.deleted_99999999901')?.response).toMatchObject({ desfecho: 'registrado_sem_produto' });
    expect(upsert).not.toHaveBeenCalled();
  });

  it('reentrega do evento já processado não repete o efeito', async () => {
    await entregar(exclusao());
    const segunda = await entregar(exclusao());

    expect(segunda.status).toBe(200);
    expect(chamadasDaExclusao()).toHaveLength(1);
    expect(tombstones.size).toBe(1);
  });

  it('a mesma exclusão com outro eventId é absorvida pelo banco (ja_registrado)', async () => {
    await entregar(exclusao(BLING_ID, { eventId: 'evt-1' }));
    await entregar(exclusao(BLING_ID, { eventId: 'evt-2' }));

    expect(chamadasDaExclusao()).toHaveLength(2);
    expect(tombstones.size).toBe(1);
    expect(respostaNoInbox(ORG_A, 'product.deleted_evt-2')?.response).toMatchObject({ desfecho: 'ja_registrado' });
  });

  it('update atrasado depois da exclusão é ignorado e auditado, sem GET nem upsert', async () => {
    await entregar(exclusao());
    for (const event of ['product.updated', 'stock.updated']) {
      const resposta = await entregar({ event, data: { id: Number(BLING_ID) } });
      expect(resposta.status).toBe(200);
      expect(respostaNoInbox(ORG_A, `${event}_${BLING_ID}`)).toMatchObject({
        status: 'processed', response: { ignored: true, reason: 'excluido_no_bling' },
      });
    }
    expect(getProduto).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('falha transacional: 503, inbox failed, nada gravado; a reentrega conclui', async () => {
    bancoCai = true;
    const primeira = await entregar(exclusao());

    expect(primeira.status).toBe(503);
    expect(respostaNoInbox(ORG_A, `product.deleted_${BLING_ID}`)?.status).toBe('failed');
    expect(tombstones.size).toBe(0);
    expect(upsert).not.toHaveBeenCalled();

    bancoCai = false;
    const segunda = await entregar(exclusao());
    expect(segunda.status).toBe(200);
    expect(respostaNoInbox(ORG_A, `product.deleted_${BLING_ID}`)?.status).toBe('processed');
    expect(tombstones.has(chaveDe(ORG_A, BLING_ID))).toBe(true);
  });

  it('isolamento A/B: a exclusão assinada por B atinge só B, e A segue sincronizando', async () => {
    await entregar(exclusao(), ORG_B);

    expect(chamadasDaExclusao()).toEqual([['registrar_exclusao_de_produto_no_bling', expect.objectContaining({ p_organizacao_id: ORG_B })]]);
    expect([...tombstones.keys()]).toEqual([chaveDe(ORG_B, BLING_ID)]);

    const updateEmA = await entregar({ event: 'product.updated', data: { id: Number(BLING_ID) } }, ORG_A);
    expect(updateEmA.status).toBe(200);
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ organizationId: ORG_A }), expect.objectContaining({ bling_id: BLING_ID }));
  });

  it('id que não é do Bling: ignorado e auditado, sem tocar o banco', async () => {
    const resposta = await entregar(exclusao('LOCAL-7'));

    expect(resposta.status).toBe(200);
    expect(chamadasDaExclusao()).toHaveLength(0);
    expect(respostaNoInbox(ORG_A, 'product.deleted_LOCAL-7')?.response).toMatchObject({ ignored: true, reason: 'id_invalido' });
  });

  it('evento desconhecido fica no inbox como ignorado, em vez de sumir', async () => {
    const resposta = await entregar({ event: 'invoice.created', data: { id: 555 } });

    expect(resposta.status).toBe(200);
    expect(respostaNoInbox(ORG_A, 'invoice.created_555')).toMatchObject({
      status: 'processed', response: { ignored: true, reason: 'evento_desconhecido', entity: 'invoice.created' },
    });
  });

  it.each(['product_supplier.deleted', 'product_supplier.updated'])(
    '%s não é evento de produto: sem tombstone, sem GET, sem upsert, ignorado e auditado',
    async (event) => {
      // O payload real traz o produto aninhado; o ramo de produto o buscaria e regravaria.
      const resposta = await entregar({ event, data: { id: 555, produto: { id: Number(BLING_ID) }, fornecedor: { id: 9 } } });

      expect(resposta.status).toBe(200);
      expect(chamadasDaExclusao()).toHaveLength(0);
      expect(tombstones.size).toBe(0);
      expect(getProduto).not.toHaveBeenCalled();
      expect(getByBlingId).not.toHaveBeenCalled();
      expect(upsert).not.toHaveBeenCalled();
      expect(respostaNoInbox(ORG_A, `${event}_555`)).toMatchObject({
        status: 'processed', response: { ignored: true, reason: 'evento_desconhecido', entity: event },
      });
    },
  );
});

describe('webhook: conclusão do inbox que o banco não grava', () => {
  it('não responde 200 sem o processed gravado; o evento fica failed e a reentrega conclui sem repetir efeito', async () => {
    conclusaoRecusada = new Set(['processed']);
    const primeira = await entregar(exclusao());

    expect(primeira.status).toBe(503);
    expect(respostaNoInbox(ORG_A, `product.deleted_${BLING_ID}`)?.status).toBe('failed');
    expect(tombstones.size).toBe(1);

    conclusaoRecusada = new Set();
    const segunda = await entregar(exclusao());

    expect(segunda.status).toBe(200);
    expect(respostaNoInbox(ORG_A, `product.deleted_${BLING_ID}`)).toMatchObject({
      status: 'processed', response: { desfecho: 'ja_registrado' },
    });
    expect(tombstones.size).toBe(1);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('nem quando o banco também recusa o failed: 503, evento received e reprocessável', async () => {
    conclusaoRecusada = new Set(['processed', 'failed']);
    const primeira = await entregar({ event: 'invoice.created', data: { id: 777 } });

    expect(primeira.status).toBe(503);
    expect(respostaNoInbox(ORG_A, 'invoice.created_777')?.status).toBe('received');

    conclusaoRecusada = new Set();
    const segunda = await entregar({ event: 'invoice.created', data: { id: 777 } });
    expect(segunda.status).toBe(200);
    expect(respostaNoInbox(ORG_A, 'invoice.created_777')?.status).toBe('processed');
  });
});
