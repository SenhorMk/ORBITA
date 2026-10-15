import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import crypto from 'node:crypto';

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project-ref.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'public-key-12345678901234567890';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'server-key-12345678901234567890';
process.env.ENCRYPTION_KEY = 'ab'.repeat(32);

import { encrypt } from '../../../../lib/crypto';

/**
 * PRE-005: `contact.deleted` do Bling marca o contato como excluído, sem
 * apagá-lo nem inventar `Cliente #id`. O webhook passa pela assinatura real
 * (HMAC), pelo inbox idempotente e pelo repositório real até o
 * `supabaseServer`, aqui um banco em memória com o contrato da migration 77. O
 * comportamento do próprio banco (preservar, recusar a recriação, reativar só
 * pelo comando, concorrência) é provado no pgTAP e no ensaio de concorrência.
 */

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const SECRET: Record<string, string> = { [ORG_A]: 'secret-bling-org-a', [ORG_B]: 'secret-bling-org-b' };
const DONO: Record<string, string> = { [ORG_A]: 'a1a1a1a1-0000-4000-8000-0000000000a1', [ORG_B]: 'b2b2b2b2-0000-4000-8000-0000000000b2' };
const BLING_ID = '17000000001';

type EventoNoInbox = { id: string; status: string; response: Record<string, unknown> | null };
let inbox: Map<string, EventoNoInbox>;
let exclusoes: Map<string, { excluidoNoBlingEm: unknown }>;
/** Contatos locais por (organização, bling_id) → nome. */
let contatos: Map<string, string>;
let bancoCai: boolean;

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
    const evento = eventoPorId(args.p_evento_id);
    if (evento) Object.assign(evento, { status: args.p_status, response: args.p_response_body ?? null });
    return { data: null, error: null };
  }
  if (nome === 'registrar_exclusao_de_contato_no_bling') {
    // Uma transação: ou grava tudo, ou nada.
    if (bancoCai) return { data: null, error: { code: '08006', message: 'conexão com o banco recusada' } };
    const chave = chaveDe(args.p_organizacao_id, args.p_bling_id);
    if (exclusoes.has(chave)) return { data: [{ desfecho: 'ja_registrado', cliente_id: null }], error: null };
    exclusoes.set(chave, { excluidoNoBlingEm: args.p_excluido_no_bling_em });
    return { data: [{ desfecho: contatos.has(chave) ? 'registrado' : 'registrado_sem_contato', cliente_id: null }], error: null };
  }
  throw new Error(`rpc inesperada: ${nome}`);
});

/** Encadeia filtros (`eq`, `is`) e resolve com o que `resolver` decidir por eles. */
function consulta(resolver: (filtros: Record<string, unknown>) => unknown) {
  const filtros: Record<string, unknown> = {};
  const cadeia = {
    select: () => cadeia,
    eq: (col: string, valor: unknown) => { filtros[col] = valor; return cadeia; },
    is: (col: string, valor: unknown) => { filtros[col] = valor; return cadeia; },
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
      if (tabela === 'contatos_excluidos_no_bling') {
        return consulta((f) => (f.reativado_em === null && exclusoes.has(chaveDe(f.organizacao_id, f.bling_id)) ? { id: 'excl-1' } : null));
      }
      throw new Error(`tabela inesperada: ${tabela}`);
    },
  },
}));

vi.mock('../../../../services/bling', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../../services/bling')>(),
  bling: { forOrganization: () => ({ getProduto: vi.fn(), getPedido: vi.fn() }) },
}));

const getByBlingId = vi.fn(async (escopo: { organizationId: string }, blingId: string) => {
  const nome = contatos.get(chaveDe(escopo.organizationId, blingId));
  return nome ? { bling_id: blingId, nome } : null;
});
const upsert = vi.fn(async (_escopo: unknown, cliente: unknown) => cliente);
vi.mock('../../../../repositories/clienteRepository', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../../repositories/clienteRepository')>();
  return {
    ...real,
    clienteRepository: {
      // O caminho da exclusão é o real, até o `supabaseServer`.
      registrarExclusaoNoBling: real.clienteRepository.registrarExclusaoNoBling.bind(real.clienteRepository),
      exclusaoVigenteNoBling: real.clienteRepository.exclusaoVigenteNoBling.bind(real.clienteRepository),
      getByBlingId,
      upsert,
    },
  };
});

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

const exclusao = (id: unknown = BLING_ID, extra: Record<string, unknown> = {}) => ({ event: 'contact.deleted', data: { id }, ...extra });
const respostaNoInbox = (org: string, chave: string) => inbox.get(chaveDe(org, chave));
const chamadasDaExclusao = () => rpc.mock.calls.filter(([nome]) => nome === 'registrar_exclusao_de_contato_no_bling');
const nomesGravados = () => upsert.mock.calls.map(([, c]) => (c as { nome: string }).nome);

beforeEach(() => {
  inbox = new Map();
  exclusoes = new Map();
  contatos = new Map([[chaveDe(ORG_A, BLING_ID), 'Maria Real'], [chaveDe(ORG_B, BLING_ID), 'Cliente de B']]);
  bancoCai = false;
  rpc.mockClear();
  getByBlingId.mockClear();
  upsert.mockClear();
});

describe('webhook: contact.deleted marca o contato como excluído (PRE-005)', () => {
  it('payload mínimo: registra a exclusão sem leitura nem upsert, e sem Cliente #id', async () => {
    const resposta = await entregar({ ...exclusao(Number(BLING_ID)), date: '2026-10-14T10:00:00Z' });

    expect(resposta.status).toBe(200);
    expect(chamadasDaExclusao()).toEqual([['registrar_exclusao_de_contato_no_bling', {
      p_organizacao_id: ORG_A, p_bling_id: BLING_ID, p_excluido_no_bling_em: '2026-10-14T10:00:00.000Z',
    }]]);
    expect(getByBlingId).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(respostaNoInbox(ORG_A, `contact.deleted_${BLING_ID}`)).toMatchObject({
      status: 'processed',
      response: { success: true, entity: 'contato', acao: 'excluido_no_bling', blingId: BLING_ID, desfecho: 'registrado' },
    });
  });

  it('contact.updated com situação E (Excluído) também é exclusão, antes do upsert', async () => {
    await entregar({ event: 'contact.updated', data: { id: Number(BLING_ID), nome: 'Maria Real', situacao: 'E' } });

    expect(chamadasDaExclusao()).toHaveLength(1);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('contato que o ORBITA nunca teve: exclusão registrada, nenhum contato criado', async () => {
    const resposta = await entregar(exclusao('99999999901'));

    expect(resposta.status).toBe(200);
    expect(respostaNoInbox(ORG_A, 'contact.deleted_99999999901')?.response).toMatchObject({ desfecho: 'registrado_sem_contato' });
    expect(upsert).not.toHaveBeenCalled();
  });

  it('reentrega do evento já processado não repete o efeito; outro eventId é absorvido pelo banco', async () => {
    await entregar(exclusao());
    await entregar(exclusao());
    expect(chamadasDaExclusao()).toHaveLength(1);

    await entregar(exclusao(BLING_ID, { eventId: 'evt-2' }));
    expect(chamadasDaExclusao()).toHaveLength(2);
    expect(exclusoes.size).toBe(1);
    expect(respostaNoInbox(ORG_A, 'contact.deleted_evt-2')?.response).toMatchObject({ desfecho: 'ja_registrado' });
  });

  it('update atrasado depois da exclusão é ignorado e auditado: não recria, não renomeia, não reativa', async () => {
    await entregar(exclusao());
    for (const data of [{ id: Number(BLING_ID) }, { id: Number(BLING_ID), nome: 'Maria Real', situacao: 'A' }]) {
      const resposta = await entregar({ event: 'contact.updated', data, eventId: `upd-${String(data.nome)}` });
      expect(resposta.status).toBe(200);
    }
    expect(respostaNoInbox(ORG_A, 'contact.updated_upd-undefined')).toMatchObject({
      status: 'processed', response: { ignored: true, reason: 'excluido_no_bling' },
    });
    expect(upsert).not.toHaveBeenCalled();
  });

  it('atualização sem nome nunca inventa Cliente #id: usa o nome gravado, ou não cria', async () => {
    await entregar({ event: 'contact.updated', data: { id: Number(BLING_ID), email: 'maria@exemplo.test' } });
    await entregar({ event: 'contact.created', data: { id: 99999999902 } });

    expect(nomesGravados()).toEqual(['Maria Real']);
    expect(nomesGravados().some((n) => n.startsWith('Cliente #'))).toBe(false);
    expect(respostaNoInbox(ORG_A, 'contact.created_99999999902')?.response).toMatchObject({ ignored: true, reason: 'contato_sem_nome' });
  });

  it('isolamento A/B: a exclusão assinada por B atinge só B, e A segue sincronizando', async () => {
    await entregar(exclusao(), ORG_B);

    expect(chamadasDaExclusao()).toEqual([['registrar_exclusao_de_contato_no_bling', expect.objectContaining({ p_organizacao_id: ORG_B })]]);
    expect([...exclusoes.keys()]).toEqual([chaveDe(ORG_B, BLING_ID)]);

    await entregar({ event: 'contact.updated', data: { id: Number(BLING_ID), nome: 'Maria Real' } }, ORG_A);
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ organizationId: ORG_A }), expect.objectContaining({ bling_id: BLING_ID }));
  });

  it('assinatura inválida: 403 e nenhum efeito', async () => {
    const resposta = await entregar(exclusao(), ORG_A, 'sha256=forjada');

    expect(resposta.status).toBe(403);
    expect(inbox.size).toBe(0);
    expect(exclusoes.size).toBe(0);
  });

  it('payload inválido (id que não é do Bling): ignorado e auditado, sem tocar o banco', async () => {
    const resposta = await entregar(exclusao('temp_ab12'));

    expect(resposta.status).toBe(200);
    expect(chamadasDaExclusao()).toHaveLength(0);
    expect(upsert).not.toHaveBeenCalled();
    expect(respostaNoInbox(ORG_A, 'contact.deleted_temp_ab12')?.response).toMatchObject({ ignored: true, reason: 'id_invalido' });
  });

  it('falha transacional: 503, inbox failed, nada gravado; a reentrega conclui', async () => {
    bancoCai = true;
    const primeira = await entregar(exclusao());

    expect(primeira.status).toBe(503);
    expect(respostaNoInbox(ORG_A, `contact.deleted_${BLING_ID}`)?.status).toBe('failed');
    expect(exclusoes.size).toBe(0);

    bancoCai = false;
    const segunda = await entregar(exclusao());
    expect(segunda.status).toBe(200);
    expect(respostaNoInbox(ORG_A, `contact.deleted_${BLING_ID}`)?.status).toBe('processed');
  });

  it('evento de outro recurso de contato continua ignorado e auditado', async () => {
    const resposta = await entregar({ event: 'contact_person.deleted', data: { id: Number(BLING_ID) } });

    expect(resposta.status).toBe(200);
    expect(chamadasDaExclusao()).toHaveLength(0);
    expect(respostaNoInbox(ORG_A, `contact_person.deleted_${BLING_ID}`)).toMatchObject({
      status: 'processed', response: { ignored: true, reason: 'evento_desconhecido' },
    });
  });
});
