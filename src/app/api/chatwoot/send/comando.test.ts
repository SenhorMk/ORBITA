import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EspelhoChatwootFake } from '../../../../services/__testkit__/espelhoChatwootFake';

/**
 * MSG-008: enviar é registrar uma intenção, não chamar o Chatwoot. A rota
 * recebe um `commandId` estável do navegador; a mesma identidade com o mesmo
 * conteúdo devolve a mesma intenção, e quem despacha é o worker. Banco e
 * Chatwoot dublados: a RPC de registro é um fake com a mesma regra de
 * identidade do banco (organização + commandId, digest do conteúdo).
 */

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project-ref.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'public-key-12345678901234567890';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'server-key-12345678901234567890';

const ORG_A = '22222222-2222-4222-8222-222222222222';
const ORG_B = '33333333-3333-4333-8333-333333333333';
const CONEXAO_A1 = '11111111-1111-4111-8111-111111111111';
const ATOR = '70000000-0000-4000-8000-000000000001';
const COMANDO = '80000000-0000-4000-8000-000000000001';

interface Intencao { readonly envioId: string; readonly eventoId: string; readonly conversa: string; readonly conteudo: string }

const estado = vi.hoisted(() => ({
  store: null as unknown as EspelhoChatwootFake,
  sessao: { organizacao: '', papel: 'member' as string },
  enviadas: [] as Array<{ conversa: number; conteudo: string }>,
  intencoes: new Map<string, Intencao>(),
  chamadasRpc: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  enqueue: vi.fn(),
  bancoFora: false,
  /** Resultado que o banco devolve antes de olhar a intenção (vínculo, conexão). */
  recusaDoBanco: null as null | 'sem_vinculo' | 'conexao_indisponivel',
  consultas: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../../../services/chatwoot/espelhoChatwootSupabase', () => ({
  criarEspelhoChatwootSupabase: () => new Proxy({}, {
    get: (_alvo, operacao: string) => (...args: unknown[]) =>
      (estado.store as unknown as Record<string, (...a: unknown[]) => unknown>)[operacao]!(...args),
  }),
}));
vi.mock('../../../../lib/supabaseServer', () => ({
  supabaseServer: {
    // A consulta dos envios: registra os filtros e devolve uma linha por intenção.
    from: (tabela: string) => {
      const filtros: Record<string, unknown> = { tabela };
      const consulta = {
        select: () => consulta,
        eq: (coluna: string, valor: unknown) => { filtros[coluna] = valor; return consulta; },
        order: () => consulta,
        limit: async () => {
          estado.consultas.push(filtros);
          const linhas = [...estado.intencoes.entries()]
            .filter(([chave, i]) => chave.startsWith(String(filtros.organizacao_id)) && i.conversa === filtros.conversa_id_local)
            .map(([chave, i]) => ({
              id: i.envioId, command_id: chave.split(':')[1], conteudo: i.conteudo, mensagem_id_local: null, created_at: '2026-11-05T12:00:00Z',
              outbox_eventos: { status: 'unknown', motivo_bloqueio: 'timeout', resolucao: null },
            }));
          return { data: linhas, error: null };
        },
      };
      return consulta;
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      estado.chamadasRpc.push({ fn, args });
      if (fn !== 'registrar_envio_chatwoot') return { data: null, error: { message: `rpc inesperada ${fn}` } };
      if (estado.bancoFora) return { data: null, error: { message: 'banco caiu' } };
      if (estado.recusaDoBanco) return { data: [{ resultado: estado.recusaDoBanco, envio_id: null, evento_id: null, status: null }], error: null };
      // Como no banco: a conversa é procurada só na organização da sessão.
      const conversa = estado.store.porIdLocal('conversa', String(args.p_conversa_id_local));
      if (!conversa || conversa.organizacao_id !== args.p_organizacao_id) {
        return { data: [{ resultado: 'conversa_inexistente', envio_id: null, evento_id: null, status: null }], error: null };
      }
      const chave = `${String(args.p_organizacao_id)}:${String(args.p_command_id)}`;
      const existente = estado.intencoes.get(chave);
      if (existente) {
        const mesma = existente.conversa === args.p_conversa_id_local && existente.conteudo === args.p_conteudo;
        return { data: [{ resultado: mesma ? 'existente' : 'conflito', envio_id: existente.envioId, evento_id: existente.eventoId, status: 'pending' }], error: null };
      }
      const nova = { envioId: `envio-${estado.intencoes.size + 1}`, eventoId: `evt-${estado.intencoes.size + 1}`, conversa: String(args.p_conversa_id_local), conteudo: String(args.p_conteudo) };
      estado.intencoes.set(chave, nova);
      return { data: [{ resultado: 'registrado', envio_id: nova.envioId, evento_id: nova.eventoId, status: 'pending' }], error: null };
    },
  },
}));
vi.mock('../../../../lib/requestOrganizationContext', () => ({
  resolveActiveRequestOrganizationContext: vi.fn(async () => ({
    _tag: 'OrganizationContextResolved',
    context: { organizacao: estado.sessao.organizacao, papel: estado.sessao.papel },
  })),
}));
vi.mock('../../../../lib/verifiedOrganizationScope', () => ({
  organizationContextToScope: (context: { organizacao: string; papel: string }) =>
    ({ organizationId: context.organizacao, actorId: ATOR, role: context.papel }),
  escopoTemCapacidade: (scope: { role: string }) => scope.role !== 'sem-acesso',
}));
vi.mock('../../../../services/outboxService', () => ({
  outboxService: {
    enqueue: (...a: unknown[]) => estado.enqueue(...a),
    startDispatch: async () => true,
    concludeAttempt: async (_s: unknown, _p: unknown, desfecho: { _tag: string }) =>
      ({ Confirmado: 'sent', NaoEnviado: 'failed_transient', Recusado: 'dead_letter', Desconhecido: 'unknown' })[desfecho._tag],
  },
}));
vi.mock('../../../../services/auditService', () => ({ recordSystemAuditEvent: async () => 'audit-1' }));
vi.mock('../../../../services/chatwoot/chatwootAdapter', () => ({
  ChatwootAdapter: {
    forScope: vi.fn(async () => ({
      sendMessage: async (conversa: number, conteudo: string) => {
        estado.enviadas.push({ conversa, conteudo });
        return { _tag: 'ChatwootSuccess', data: { id: 9000 + estado.enviadas.length, message_type: 1 } };
      },
    })),
  },
}));

function semearConversa(organizacao: string, conexao: string): string {
  const contato = estado.store.semear('contato', { id: 5, organizacao_id: organizacao, conexao_id: conexao, name: 'Contato' });
  return estado.store.semear('conversa', {
    id: 50, organizacao_id: organizacao, conexao_id: conexao, contact_id: 5, contato_id_local: contato, status: 'open',
  });
}

async function enviar(corpo: unknown, organizacao = ORG_A, papel = 'member') {
  estado.sessao = { organizacao, papel };
  const { POST } = await import('./route');
  const res = await POST(new Request('https://orbita.test/api/chatwoot/send', { method: 'POST', body: JSON.stringify(corpo) }));
  return { status: res.status, body: await res.json() };
}

beforeEach(async () => {
  const { EspelhoChatwootFake } = await import('../../../../services/__testkit__/espelhoChatwootFake');
  estado.store = new EspelhoChatwootFake({ pkGlobal: false });
  estado.enviadas.length = 0;
  estado.intencoes.clear();
  estado.chamadasRpc.length = 0;
  estado.bancoFora = false;
  estado.recusaDoBanco = null;
  estado.consultas.length = 0;
  let n = 0;
  estado.enqueue.mockReset().mockImplementation(async () => ({ eventoId: `evt-legado-${++n}` }));
});

describe('POST /api/chatwoot/send registra a intenção (MSG-008)', () => {
  it('não chama o Chatwoot dentro da requisição', async () => {
    const conversa = semearConversa(ORG_A, CONEXAO_A1);
    const { status, body } = await enviar({ conversaId: conversa, commandId: COMANDO, content: 'olá' });

    expect(estado.enviadas).toHaveLength(0);
    expect(status).toBe(202);
    expect(body).toMatchObject({ success: true, envio: { id: 'envio-1', commandId: COMANDO, estado: 'pendente' } });
  });

  it('clique duplo, reload ou POST repetido com o mesmo commandId devolvem a mesma intenção', async () => {
    const conversa = semearConversa(ORG_A, CONEXAO_A1);
    const primeira = await enviar({ conversaId: conversa, commandId: COMANDO, content: 'olá' });
    const segunda = await enviar({ conversaId: conversa, commandId: COMANDO, content: 'olá' });

    expect(estado.enviadas).toHaveLength(0);
    expect(segunda.status).toBe(202);
    expect(segunda.body.envio.id).toBe(primeira.body.envio.id);
    expect(segunda.body.envio.duplicado).toBe(true);
  });

  it('mesmo commandId com outro conteúdo é conflito explícito, sem nova intenção', async () => {
    const conversa = semearConversa(ORG_A, CONEXAO_A1);
    await enviar({ conversaId: conversa, commandId: COMANDO, content: 'olá' });
    const { status, body } = await enviar({ conversaId: conversa, commandId: COMANDO, content: 'outro texto' });

    expect(status).toBe(409);
    expect(body.motivo).toBe('comando_divergente');
    expect(estado.intencoes.size).toBe(1);
  });

  it('a identidade é o commandId do navegador, não o relógio do servidor', async () => {
    const conversa = semearConversa(ORG_A, CONEXAO_A1);
    await enviar({ conversaId: conversa, commandId: COMANDO, content: 'olá' });
    await enviar({ conversaId: conversa, commandId: COMANDO, content: 'olá' });

    const comandos = estado.chamadasRpc.filter((c) => c.fn === 'registrar_envio_chatwoot').map((c) => c.args.p_command_id);
    expect(comandos).toEqual([COMANDO, COMANDO]);
    expect(estado.enqueue).not.toHaveBeenCalled();
  });

  it('sem commandId UUID a requisição é recusada antes de qualquer registro', async () => {
    const conversa = semearConversa(ORG_A, CONEXAO_A1);
    const { status } = await enviar({ conversaId: conversa, content: 'olá' });

    expect(status).toBe(400);
    expect(estado.chamadasRpc).toHaveLength(0);
    expect(estado.enviadas).toHaveLength(0);
  });

  it('uma queda do banco não deixa envio externo para trás nem afirma entrega', async () => {
    const conversa = semearConversa(ORG_A, CONEXAO_A1);
    estado.bancoFora = true;
    const { status, body } = await enviar({ conversaId: conversa, commandId: COMANDO, content: 'olá' });

    expect(estado.enviadas).toHaveLength(0);
    expect(status).toBe(503);
    expect(body.success).toBe(false);
  });

  it('organização vem da sessão: o mesmo commandId em B é outra intenção, e a conversa de A não é alcançada', async () => {
    const conversaA = semearConversa(ORG_A, CONEXAO_A1);
    await enviar({ conversaId: conversaA, commandId: COMANDO, content: 'olá' });
    const deB = await enviar({ conversaId: conversaA, commandId: COMANDO, content: 'olá' }, ORG_B);

    expect(deB.status).toBe(404);
    expect(estado.intencoes.size).toBe(1);
    expect(estado.enviadas).toHaveLength(0);
  });

  it('sem a capacidade de envio, nada é registrado', async () => {
    const conversa = semearConversa(ORG_A, CONEXAO_A1);
    const { status } = await enviar({ conversaId: conversa, commandId: COMANDO, content: 'olá' }, ORG_A, 'sem-acesso');

    expect(status).toBe(403);
    expect(estado.chamadasRpc).toHaveLength(0);
  });

  it('id remoto como referência é recusado, sem registro', async () => {
    semearConversa(ORG_A, CONEXAO_A1);
    const { status } = await enviar({ conversationId: 50, commandId: COMANDO, content: 'pelo id remoto' });

    expect(status).toBe(400);
    expect(estado.chamadasRpc).toHaveLength(0);
  });

  it('conexão desligada ou ausente: 409 tipado, e o banco não grava intenção', async () => {
    const conversa = semearConversa(ORG_A, CONEXAO_A1);
    estado.recusaDoBanco = 'conexao_indisponivel';
    const { status, body } = await enviar({ conversaId: conversa, commandId: COMANDO, content: 'olá' });

    expect(status).toBe(409);
    expect(body.motivo).toBe('conexao_indisponivel');
    expect(estado.intencoes.size).toBe(0);
  });

  it('sem vínculo com a organização no banco: 403', async () => {
    const conversa = semearConversa(ORG_A, CONEXAO_A1);
    estado.recusaDoBanco = 'sem_vinculo';
    const { status } = await enviar({ conversaId: conversa, commandId: COMANDO, content: 'olá' });

    expect(status).toBe(403);
  });
});

describe('GET /api/chatwoot/send (MSG-008)', () => {
  it('lista os envios da conversa na organização da sessão, com o estado e sem oferecer reenvio', async () => {
    const conversa = semearConversa(ORG_A, CONEXAO_A1);
    await enviar({ conversaId: conversa, commandId: COMANDO, content: 'olá' });
    estado.sessao = { organizacao: ORG_A, papel: 'member' };
    const { GET } = await import('./route');
    const res = await GET(new Request(`https://orbita.test/api/chatwoot/send?conversaId=${conversa}`));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(estado.consultas).toEqual([{ tabela: 'chatwoot_envios', organizacao_id: ORG_A, conversa_id_local: conversa }]);
    expect(body.envios).toEqual([expect.objectContaining({ commandId: COMANDO, estado: 'desconhecido' })]);
    expect(body.envios[0].explicacao).toContain('Não reenvie');
  });

  it('sem conversaId UUID: 400', async () => {
    estado.sessao = { organizacao: ORG_A, papel: 'member' };
    const { GET } = await import('./route');
    expect((await GET(new Request('https://orbita.test/api/chatwoot/send?conversaId=50'))).status).toBe(400);
  });
});
