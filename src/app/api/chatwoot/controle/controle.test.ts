import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * MSG-009: assumir, devolver e exigir humano. A rota só traduz: organização e
 * ator vêm da sessão, a regra (versão, dono, transição) é do banco. A RPC é
 * dublada aqui; a regra está provada em Postgres real no pgTAP e no ensaio de
 * concorrência.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project-ref.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'public-key-12345678901234567890';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'server-key-12345678901234567890';

const ORG_A = '22222222-2222-4222-8222-222222222222';
const ORG_B = '33333333-3333-4333-8333-333333333333';
const ATOR = '70000000-0000-4000-8000-000000000001';
const CONVERSA = '90000000-0000-4000-8000-000000000001';
const COMANDO = '80000000-0000-4000-8000-000000000001';

type Linha = Record<string, unknown>;

const estado = vi.hoisted(() => ({
  sessao: { organizacao: '', capacidades: ['organization:access'] as string[], resolvida: true },
  chamadas: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  resposta: null as Linha | null,
  bancoFora: false,
  /** A conversa como o banco a vê: organização dona e controle (sem controle, linha ausente). */
  conversa: null as Linha | null,
  automacaoAtiva: false,
}));

vi.mock('../../../../lib/supabaseServer', () => ({
  supabaseServer: {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      estado.chamadas.push({ fn, args });
      if (estado.bancoFora) return { data: null, error: { message: 'banco caiu' } };
      if (fn === 'ler_controle_atendimento_chatwoot') {
        const c = estado.conversa;
        if (!c || c.organizacao_id !== args.p_organizacao_id) return { data: [{ resultado: 'conversa_inexistente' }], error: null };
        return {
          data: [{
            resultado: 'encontrada', ownership_mode: c.ownership_mode ?? 'HUMAN_REQUIRED',
            responsavel_id: c.responsavel_id ?? null, control_version: c.control_version ?? 0,
          }],
          error: null,
        };
      }
      return { data: estado.resposta ? [estado.resposta] : [], error: null };
    },
  },
}));
vi.mock('../../../../services/chatwoot/automacaoDoAtendimento', () => ({
  automacaoDoAtendimentoAtiva: () => estado.automacaoAtiva,
}));
vi.mock('../../../../lib/requestOrganizationContext', () => ({
  resolveActiveRequestOrganizationContext: vi.fn(async () => (estado.sessao.resolvida
    ? { _tag: 'OrganizationContextResolved', context: { organizacao: estado.sessao.organizacao, capacidades: estado.sessao.capacidades } }
    : { _tag: 'IdentityRejected' })),
}));
vi.mock('../../../../lib/organizationAuthorization', () => ({
  organizationContextStatus: () => 401,
}));
vi.mock('../../../../lib/verifiedOrganizationScope', () => ({
  organizationContextToScope: (context: { organizacao: string; capacidades: string[] }) =>
    ({ organizationId: context.organizacao, actorId: ATOR, capabilities: new Set(context.capacidades) }),
  escopoTemCapacidade: (scope: { capabilities: Set<string> }, capacidade: string) => scope.capabilities.has(capacidade),
}));

function aplicado(modo: string, versao: number, extra: Linha = {}): Linha {
  return {
    resultado: 'aplicado', ownership_mode: modo, responsavel_id: modo === 'HUMAN' ? ATOR : null,
    control_version: versao, invalidados: 0, em_voo: 0, nota_envio_id: null, ...extra,
  };
}

async function alterar(corpo: unknown, organizacao = ORG_A, capacidades = ['organization:access']) {
  estado.sessao = { organizacao, capacidades, resolvida: true };
  const { POST } = await import('./route');
  const res = await POST(new Request('https://orbita.test/api/chatwoot/controle', { method: 'POST', body: JSON.stringify(corpo) }));
  return { status: res.status, body: await res.json() };
}

async function ler(conversaId: string, organizacao = ORG_A, capacidades = ['organization:access']) {
  estado.sessao = { organizacao, capacidades, resolvida: true };
  const { GET } = await import('./route');
  const res = await GET(new Request(`https://orbita.test/api/chatwoot/controle?conversaId=${conversaId}`));
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  estado.chamadas.length = 0;
  estado.resposta = null;
  estado.bancoFora = false;
  estado.conversa = null;
  estado.automacaoAtiva = false;
});

describe('POST /api/chatwoot/controle (MSG-009)', () => {
  it('assumir usa organização e ator da sessão, nunca do corpo', async () => {
    estado.resposta = aplicado('HUMAN', 1, { invalidados: 2, em_voo: 1, nota_envio_id: 'a0000000-0000-4000-8000-000000000001' });
    const { status, body } = await alterar({
      conversaId: CONVERSA, commandId: COMANDO, acao: 'assumir', versaoEsperada: 0,
      organizacaoId: ORG_B, atorId: '70000000-0000-4000-8000-0000000000ff',
    });

    expect(status).toBe(200);
    expect(estado.chamadas).toEqual([{
      fn: 'alterar_controle_atendimento_chatwoot',
      args: {
        p_organizacao_id: ORG_A, p_ator_id: ATOR, p_conversa_id_local: CONVERSA, p_command_id: COMANDO,
        p_acao: 'assumir', p_versao_esperada: 0, p_nota: null,
      },
    }]);
    expect(body).toEqual({
      success: true,
      duplicado: false,
      controle: { modo: 'HUMAN', responsavelId: ATOR, souResponsavel: true, versao: 1 },
      permissoes: { devolver: false, motivoSemDevolver: 'sem_capacidade', automacaoAtiva: false },
      invalidados: 2,
      emVoo: 1,
      notaRegistrada: true,
    });
  });

  it('a mesma ação repetida (resposta perdida) devolve o resultado gravado, marcado como duplicado', async () => {
    estado.resposta = { ...aplicado('HUMAN', 1), resultado: 'existente' };
    const { status, body } = await alterar({ conversaId: CONVERSA, commandId: COMANDO, acao: 'assumir', versaoEsperada: 0 });

    expect(status).toBe(200);
    expect(body.duplicado).toBe(true);
  });

  it('duas abas: a versão vencida é 409 conflito_versao com o controle atual, para recarregar', async () => {
    estado.resposta = { ...aplicado('HUMAN', 3), resultado: 'conflito_versao' };
    const { status, body } = await alterar({ conversaId: CONVERSA, commandId: COMANDO, acao: 'assumir', versaoEsperada: 2 });

    expect(status).toBe(409);
    expect(body).toMatchObject({ motivo: 'conflito_versao', controle: { modo: 'HUMAN', versao: 3 } });
  });

  it.each([
    ['conflito_comando', 409],
    ['conversa_inexistente', 404],
    ['sem_vinculo', 403],
    ['sem_capacidade', 403],
  ])('resultado %s do banco vira %i, sem afirmar mudança', async (resultado, esperado) => {
    estado.resposta = { resultado, ownership_mode: null, responsavel_id: null, control_version: null, invalidados: 0, em_voo: 0, nota_envio_id: null };
    const { status, body } = await alterar({ conversaId: CONVERSA, commandId: COMANDO, acao: 'assumir', versaoEsperada: 0 });

    expect(status).toBe(esperado);
    expect(body.success).toBe(false);
  });

  it.each([
    ['ação desconhecida', { acao: 'aprovar', versaoEsperada: 0 }],
    ['versão negativa', { acao: 'assumir', versaoEsperada: -1 }],
    ['versão fracionária', { acao: 'assumir', versaoEsperada: 1.5 }],
    ['devolver sem resumo', { acao: 'devolver', versaoEsperada: 1 }],
    ['nota longa demais', { acao: 'assumir', versaoEsperada: 0, nota: 'x'.repeat(2001) }],
    ['commandId não UUID', { acao: 'assumir', versaoEsperada: 0, commandId: 'abc' }],
  ])('%s: 400 antes de qualquer chamada ao banco', async (_nome, corpo) => {
    const { status } = await alterar({ conversaId: CONVERSA, commandId: COMANDO, ...corpo });

    expect(status).toBe(400);
    expect(estado.chamadas).toHaveLength(0);
  });

  it('devolver à automação exige organization:manage: membro recebe 403 sem chamar o banco', async () => {
    const { status } = await alterar({ conversaId: CONVERSA, commandId: COMANDO, acao: 'devolver', versaoEsperada: 1, nota: 'Resolvido.' });

    expect(status).toBe(403);
    expect(estado.chamadas).toHaveLength(0);
  });

  it('sem automação ativa, devolver é 409 automacao_inativa sem chamar o banco: a conversa não fica sem ninguém', async () => {
    const { status, body } = await alterar(
      { conversaId: CONVERSA, commandId: COMANDO, acao: 'devolver', versaoEsperada: 1, nota: 'Resolvido.' },
      ORG_A, ['organization:access', 'organization:manage'],
    );

    expect(status).toBe(409);
    expect(body).toMatchObject({ success: false, motivo: 'automacao_inativa' });
    expect(estado.chamadas).toHaveLength(0);
  });

  it('com automação ativa, quem gerencia devolve com resumo; o resumo vai ao banco aparado', async () => {
    estado.automacaoAtiva = true;
    estado.resposta = aplicado('AI', 2, { nota_envio_id: 'a0000000-0000-4000-8000-000000000002' });
    const { status, body } = await alterar(
      { conversaId: CONVERSA, commandId: COMANDO, acao: 'devolver', versaoEsperada: 1, nota: '  Pedido localizado.  ' },
      ORG_A, ['organization:access', 'organization:manage'],
    );

    expect(status).toBe(200);
    expect(estado.chamadas[0]!.args).toMatchObject({ p_acao: 'devolver', p_nota: 'Pedido localizado.' });
    expect(body.controle).toMatchObject({ modo: 'AI', responsavelId: null, souResponsavel: false });
  });

  it('sem capacidade de acesso: 403 sem chamar o banco', async () => {
    const { status } = await alterar({ conversaId: CONVERSA, commandId: COMANDO, acao: 'assumir', versaoEsperada: 0 }, ORG_A, []);

    expect(status).toBe(403);
    expect(estado.chamadas).toHaveLength(0);
  });

  it('sessão não verificada: recusa sem chamar o banco', async () => {
    estado.sessao = { organizacao: ORG_A, capacidades: [], resolvida: false };
    const { POST } = await import('./route');
    const res = await POST(new Request('https://orbita.test/api/chatwoot/controle', {
      method: 'POST', body: JSON.stringify({ conversaId: CONVERSA, commandId: COMANDO, acao: 'assumir', versaoEsperada: 0 }),
    }));

    expect(res.status).toBe(401);
    expect(estado.chamadas).toHaveLength(0);
  });

  it('transição inválida (ex.: devolver conversa que não é sua) é 409 com o controle atual', async () => {
    estado.resposta = { ...aplicado('HUMAN', 5), responsavel_id: '70000000-0000-4000-8000-0000000000ff', resultado: 'transicao_invalida' };
    const { status, body } = await alterar({ conversaId: CONVERSA, commandId: COMANDO, acao: 'assumir', versaoEsperada: 5 });

    expect(status).toBe(409);
    expect(body).toMatchObject({ motivo: 'transicao_invalida', controle: { modo: 'HUMAN', souResponsavel: false, versao: 5 } });
  });

  it('banco fora: 503, sem afirmar mudança', async () => {
    estado.bancoFora = true;
    const { status, body } = await alterar({ conversaId: CONVERSA, commandId: COMANDO, acao: 'assumir', versaoEsperada: 0 });

    expect(status).toBe(503);
    expect(body.success).toBe(false);
  });

  it('resposta do banco fora do contrato: 503, nunca sucesso inventado', async () => {
    estado.resposta = { resultado: 'aplicado', ownership_mode: 'DONO', responsavel_id: null, control_version: 1, invalidados: 0, em_voo: 0, nota_envio_id: null };
    const { status } = await alterar({ conversaId: CONVERSA, commandId: COMANDO, acao: 'assumir', versaoEsperada: 0 });

    expect(status).toBe(503);
  });
});

describe('GET /api/chatwoot/controle (MSG-009)', () => {
  const OUTRA = '70000000-0000-4000-8000-0000000000ff';

  it('conversa sem linha de controle está aguardando humano, versão 0; lida pela organização da sessão', async () => {
    estado.conversa = { organizacao_id: ORG_A };
    const { status, body } = await ler(CONVERSA);

    expect(status).toBe(200);
    expect(body.controle).toEqual({ modo: 'HUMAN_REQUIRED', responsavelId: null, souResponsavel: false, versao: 0 });
    expect(estado.chamadas).toEqual([{
      fn: 'ler_controle_atendimento_chatwoot', args: { p_organizacao_id: ORG_A, p_conversa_id_local: CONVERSA },
    }]);
  });

  it('conversa inexistente: 404, nunca um estado fictício', async () => {
    const { status, body } = await ler(CONVERSA);

    expect(status).toBe(404);
    expect(body).toEqual({ success: false, error: 'Conversa não encontrada' });
  });

  it('conversa de outra organização: 404 (a sessão de B não alcança a conversa de A)', async () => {
    estado.conversa = { organizacao_id: ORG_A, ownership_mode: 'HUMAN', responsavel_id: ATOR, control_version: 4 };
    const { status, body } = await ler(CONVERSA, ORG_B);

    expect(status).toBe(404);
    expect(body.controle).toBeUndefined();
  });

  it('com a conversa assumida pela própria pessoa, souResponsavel é verdadeiro', async () => {
    estado.conversa = { organizacao_id: ORG_A, ownership_mode: 'HUMAN', responsavel_id: ATOR, control_version: 4 };
    const { body } = await ler(CONVERSA);

    expect(body.controle).toEqual({ modo: 'HUMAN', responsavelId: ATOR, souResponsavel: true, versao: 4 });
  });

  it.each([
    ['dono comum (membro): ser responsável não dá permissão de gerenciar', ATOR, ['organization:access'], false,
      { devolver: false, motivoSemDevolver: 'sem_capacidade', automacaoAtiva: false }],
    ['dono gestor, sem automação ativa', ATOR, ['organization:access', 'organization:manage'], false,
      { devolver: false, motivoSemDevolver: 'automacao_inativa', automacaoAtiva: false }],
    ['dono gestor, com automação ativa', ATOR, ['organization:access', 'organization:manage'], true,
      { devolver: true, motivoSemDevolver: null, automacaoAtiva: true }],
    ['gestor, mas a conversa é de outra pessoa', OUTRA, ['organization:access', 'organization:manage'], true,
      { devolver: false, motivoSemDevolver: 'nao_e_responsavel', automacaoAtiva: true }],
  ])('permissões efetivas — %s', async (_nome, responsavel, capacidades, automacao, esperado) => {
    estado.conversa = { organizacao_id: ORG_A, ownership_mode: 'HUMAN', responsavel_id: responsavel, control_version: 2 };
    estado.automacaoAtiva = automacao;
    const { status, body } = await ler(CONVERSA, ORG_A, capacidades);

    expect(status).toBe(200);
    expect(body.permissoes).toEqual(esperado);
  });

  it('resposta do banco fora do contrato: 503', async () => {
    estado.conversa = { organizacao_id: ORG_A, ownership_mode: 'DONO' };
    const { status } = await ler(CONVERSA);
    expect(status).toBe(503);
  });

  it('conversaId inválido: 400', async () => {
    const { status } = await ler('abc');
    expect(status).toBe(400);
  });
});
