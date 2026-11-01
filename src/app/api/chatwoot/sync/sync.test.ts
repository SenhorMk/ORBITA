import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EspelhoChatwootFake } from '../../../../services/__testkit__/espelhoChatwootFake';

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project-ref.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'public-key-12345678901234567890';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'server-key-12345678901234567890';

const ORG_A = '22222222-2222-4222-8222-222222222222';
const ORG_B = '33333333-3333-4333-8333-333333333333';
const ATOR = '70000000-0000-4000-8000-000000000001';
const CONEXAO_A = '11111111-1111-4111-8111-111111111111';
const CONEXAO_B = '44444444-4444-4444-8444-444444444444';

/** A sessão de cada requisição; a fake do Chatwoot devolve sempre os ids 5/50/500. */
const estado = vi.hoisted(() => ({
  store: null as unknown as EspelhoChatwootFake,
  sessao: { organizacao: '' },
  antesDasMensagens: null as (() => void) | null,
}));

vi.mock('../../../../services/chatwoot/espelhoChatwootSupabase', () => ({
  // O módulo da rota guarda o store na carga; o proxy aponta para o store do teste corrente.
  criarEspelhoChatwootSupabase: () => new Proxy({}, {
    get: (_alvo, operacao: string) => (...args: unknown[]) =>
      (estado.store as unknown as Record<string, (...a: unknown[]) => unknown>)[operacao]!(...args),
  }),
}));
vi.mock('../../../../lib/supabaseServer', () => ({ supabaseServer: {} }));
vi.mock('../../../../lib/requestOrganizationContext', () => ({
  resolveActiveRequestOrganizationContext: vi.fn(async () => ({
    _tag: 'OrganizationContextResolved',
    context: { organizacao: estado.sessao.organizacao },
  })),
}));
vi.mock('../../../../lib/verifiedOrganizationScope', () => ({
  organizationContextToScope: (context: { organizacao: string }) => ({ organizationId: context.organizacao, actorId: ATOR }),
}));
vi.mock('../../../../services/chatwoot/chatwootInboxRegistration', () => ({
  registerChatwootInboxIfNeeded: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../../services/integrationService', () => ({
  registroDoSacSupabase: {},
  vincularSacAoErp: vi.fn().mockResolvedValue({ criados: 0, falhas: 0 }),
}));
vi.mock('../../../../services/chatwoot/chatwootAdapter', () => ({
  ChatwootAdapter: {
    forScope: vi.fn(async (scope: { organizationId: string }) => ({
      // O adapter é o da organização do escopo verificado.
      conexaoId: scope.organizationId === ORG_A ? CONEXAO_A : CONEXAO_B,
      getConversations: () => Promise.resolve({
        _tag: 'ChatwootSuccess',
        data: [{ id: 50, display_id: 50, inbox_id: 1, status: 'open', meta: { sender: { id: 5, name: `Contato ${scope.organizationId}` } } }],
      }),
      getMessages: () => {
        estado.antesDasMensagens?.();
        return Promise.resolve({
          _tag: 'ChatwootSuccess',
          data: [{ id: 500, content: `oi de ${scope.organizationId}`, message_type: 0, created_at: '2026-10-25T00:00:00Z' }],
        });
      },
    })),
  },
}));

/** Outra escrita concorrente no espelho, na mesma conexão ou em outra da organização. */
async function outroEscritor(
  store: EspelhoChatwootFake,
  escopo: { organizacaoId: string; conexaoId: string; atorId: string },
  conteudo: string,
  modo: 'preservar' | 'sobrescrever',
) {
  const { gravarContato, gravarConversa, gravarMensagem } = await import('../../../../services/chatwoot/espelhoChatwoot');
  const contatoIdLocal = await gravarContato(store, escopo, {
    idExterno: 5, nome: 'Contato', email: null, telefone: null, telefoneNormalizado: null, avatarUrl: null,
  });
  await gravarConversa(store, escopo, {
    idExterno: 50, contatoIdLocal, contatoIdExterno: 5, displayId: null, status: 'open', inboxId: 1, canal: 'Channel::Whatsapp', statusRevisaoEm: null,
  });
  return gravarMensagem(store, escopo, {
    idExterno: 500, conversaIdExterno: 50, conteudo, tipo: 'incoming', remetenteNome: null, remetenteId: null,
    remetenteTipo: null, criadaEm: '2026-10-25T00:00:00Z', conteudoRevisaoEm: null,
  }, modo);
}

async function novoStore(pkGlobal: boolean) {
  const { EspelhoChatwootFake } = await import('../../../../services/__testkit__/espelhoChatwootFake');
  estado.store = new EspelhoChatwootFake({ pkGlobal });
  estado.antesDasMensagens = null;
}

async function sincronizar(organizacao: string) {
  estado.sessao = { organizacao };
  const { POST } = await import('./route');
  const response = await POST(new Request('https://orbita.test/api/chatwoot/sync', { method: 'POST' }));
  return { status: response.status, body: await response.json() };
}

describe('POST /api/chatwoot/sync (MSG-003A: UUID local por organização + conexão)', () => {
  beforeEach(() => novoStore(true));

  it('grava contato, conversa e mensagem ligados pelo UUID local, na organização verificada e na conexão do adapter', async () => {
    const { status, body } = await sincronizar(ORG_A);
    expect(status).toBe(200);
    expect(body.stats).toEqual({ contacts: 1, conversations: 1, messages: 1 });
    const [contato] = estado.store.linhas.contato;
    const [conversa] = estado.store.linhas.conversa;
    const [mensagem] = estado.store.linhas.mensagem;
    for (const linha of [contato, conversa, mensagem]) {
      expect(linha).toMatchObject({ organizacao_id: ORG_A, conexao_id: CONEXAO_A, user_id: ATOR });
    }
    expect(conversa!.contato_id_local).toBe(contato!.id_local);
    expect(mensagem!.conversa_id_local).toBe(conversa!.id_local);
  });

  it('sincronizar de novo não duplica e mantém os UUIDs', async () => {
    await sincronizar(ORG_A);
    const antes = estado.store.linhas.mensagem.map((l) => l.id_local);
    await sincronizar(ORG_A);
    expect(estado.store.linhas.mensagem.map((l) => l.id_local)).toEqual(antes);
    expect(estado.store.linhas.contato).toHaveLength(1);
  });

  it('antes do MSG-004, B com os mesmos ids de A é recusada sem tocar A nem inventar contagem', async () => {
    await sincronizar(ORG_A);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { status, body } = await sincronizar(ORG_B);
      expect(status).toBe(200);
      expect(body.stats).toEqual({ contacts: 0, conversations: 0, messages: 0 });
      expect(warn.mock.calls.map(([m]) => String(m)).join('\n')).toContain('IdentidadeDeOutraConexao');
    } finally {
      warn.mockRestore();
    }
    expect(estado.store.linhas.mensagem).toEqual([expect.objectContaining({ organizacao_id: ORG_A, content: `oi de ${ORG_A}` })]);
  });

  it('linha legada sem conexão (sync antigo) é adotada pela conexão do adapter, com o mesmo UUID', async () => {
    const legado = estado.store.semear('contato', { id: 5, organizacao_id: ORG_A, conexao_id: null, name: 'Sync antigo' });
    await sincronizar(ORG_A);
    expect(estado.store.linhas.contato).toEqual([expect.objectContaining({ id_local: legado, conexao_id: CONEXAO_A })]);
    expect(estado.store.linhas.conversa[0]!.contato_id_local).toBe(legado);
  });

  it('trocar a organização ativa durante o sync não muda onde ele grava', async () => {
    estado.antesDasMensagens = () => {
      estado.sessao = { organizacao: ORG_B };
    };
    await sincronizar(ORG_A);
    expect(estado.store.linhas.mensagem).toEqual([expect.objectContaining({ organizacao_id: ORG_A, conexao_id: CONEXAO_A })]);
  });

  it('sync e webhook concorrentes na mesma conexão convergem para uma linha por recurso', async () => {
    const [mensagemIdLocal] = await Promise.all([
      outroEscritor(estado.store, { organizacaoId: ORG_A, conexaoId: CONEXAO_A, atorId: ATOR }, 'pelo webhook', 'preservar'),
      sincronizar(ORG_A),
    ]);
    expect([estado.store.linhas.contato.length, estado.store.linhas.conversa.length, estado.store.linhas.mensagem.length]).toEqual([1, 1, 1]);
    expect(mensagemIdLocal).toBe(estado.store.linhas.mensagem[0]!.id_local);
  });

  it('sem versão do provedor, o sync declara null: não passa de uma revisão comprovada', async () => {
    await sincronizar(ORG_A);
    expect(estado.store.linhas.conversa[0]).toMatchObject({ status_revisao_em: null });
    expect(estado.store.linhas.mensagem[0]).toMatchObject({ conteudo_revisao_em: null });
  });
});

describe('POST /api/chatwoot/sync depois do MSG-004 (sem PK global)', () => {
  beforeEach(() => novoStore(false));

  it('A e B com os mesmos ids remotos gravam espelhos distintos por UUID', async () => {
    await sincronizar(ORG_A);
    await sincronizar(ORG_B);
    expect(estado.store.linhas.mensagem).toHaveLength(2);
    const porOrg = (org: string) => estado.store.linhas.mensagem.find((l) => l.organizacao_id === org)!;
    expect(porOrg(ORG_A).id_local).not.toBe(porOrg(ORG_B).id_local);
    expect(porOrg(ORG_A).content).toBe(`oi de ${ORG_A}`);
    expect(porOrg(ORG_B).content).toBe(`oi de ${ORG_B}`);
  });

  it('três instalações (A, segunda de A, B) com os ids 5/50/500 por webhook e sync, com replays, não se misturam', async () => {
    const CONEXAO_A2 = '11111111-1111-4111-8111-111111111112';
    const webhookA2 = (conteudo: string, evento: 'message_created' | 'message_updated' = 'message_created') =>
      outroEscritor(estado.store, { organizacaoId: ORG_A, conexaoId: CONEXAO_A2, atorId: ATOR }, conteudo, evento === 'message_created' ? 'preservar' : 'sobrescrever');

    await Promise.all([webhookA2('da segunda'), sincronizar(ORG_A)]);
    await sincronizar(ORG_B);
    // Reprocessamento e evento atrasado: a criação repetida não apaga a edição.
    await webhookA2('editada na segunda', 'message_updated');
    await webhookA2('da segunda');
    await sincronizar(ORG_A);
    await sincronizar(ORG_B);

    for (const recurso of ['contato', 'conversa', 'mensagem'] as const) expect(estado.store.linhas[recurso]).toHaveLength(3);
    const daConexao = (conexao: string) => {
      const mensagem = estado.store.linhas.mensagem.find((l) => l.conexao_id === conexao)!;
      const conversa = estado.store.porIdLocal('conversa', mensagem.conversa_id_local as string)!;
      const contato = estado.store.porIdLocal('contato', conversa.contato_id_local as string)!;
      return { mensagem, conversa, contato };
    };
    for (const [conexao, org, conteudo] of [
      [CONEXAO_A, ORG_A, `oi de ${ORG_A}`], [CONEXAO_A2, ORG_A, 'editada na segunda'], [CONEXAO_B, ORG_B, `oi de ${ORG_B}`],
    ] as const) {
      const arvore = daConexao(conexao);
      expect(arvore.mensagem).toMatchObject({ organizacao_id: org, content: conteudo });
      expect(arvore.conversa).toMatchObject({ organizacao_id: org, conexao_id: conexao });
      expect(arvore.contato).toMatchObject({ organizacao_id: org, conexao_id: conexao });
    }
  });
});
