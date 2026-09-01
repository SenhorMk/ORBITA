/**
 * Dublê da fronteira de autorização, compartilhado pelas regressões por handler.
 *
 * **O que ele substitui, e só isso:** o PostgREST e o provedor de identidade,
 * na forma exata que `resolveAuthenticatedIdentity` e
 * `SupabaseOrganizationMemberships` consomem. Nada de `role` fabricado, nada de
 * tenant pessoal, nada de sessão já autorizada entregue pronta ao handler —
 * cada teste atravessa `resolveVerifiedOrganizationScope` de verdade, e a
 * resposta sai da mesma cadeia que roda em produção.
 *
 * É esta a diferença que o ticket 22 cobra no critério 14. Um teste que troca a
 * autorização por um retorno pronto fica verde com a ligação arrancada — foi
 * assim que a troca do portão passou com 1.199 testes verdes.
 *
 * Ele não importa `vitest`: os respondentes são funções comuns, e quem quiser
 * espioná-las usa `vi.fn()` do lado do teste.
 */

/** Organização com a qual o ator do teste tem vínculo. */
export const ORG_ID = '20000000-0000-4000-8000-000000000001';
/** Uma segunda organização, para provar isolamento por par. */
export const OUTRA_ORG_ID = '20000000-0000-4000-8000-000000000002';
export const OWNER_ID = '30000000-0000-4000-8000-000000000001';
export const ADMIN_ID = '30000000-0000-4000-8000-000000000002';
export const MEMBER_ID = '30000000-0000-4000-8000-000000000003';

type RespostaPostgrest = { data: unknown; error: unknown };
type RespostaDoProvedor = {
  data: { user: { id: string; app_metadata: Record<string, unknown> } | null };
  error: { message: string; status?: number; code?: string } | null;
};

/** Papéis que `membros_organizacao` persiste. */
export type PapelDeTeste = 'owner' | 'admin' | 'member';

function linhaDeVinculo(papel: PapelDeTeste, organizacaoId: string): RespostaPostgrest {
  return {
    data: {
      papel,
      organizacao_id: organizacaoId,
      organizacoes: {
        id: organizacaoId,
        nome: 'Organização de teste',
        slug: 'org-teste',
        created_at: '2026-09-01T00:00:00Z',
        updated_at: '2026-09-01T00:00:00Z',
      },
    },
    error: null,
  };
}

/** Métodos do construtor de query que o PostgREST encadeia sem terminar a consulta. */
const ELOS_DA_CONSULTA = ['select', 'eq', 'in', 'order', 'limit', 'update', 'upsert', 'insert', 'delete'] as const;

/**
 * Construtor de query que devolve sempre a mesma resposta.
 *
 * É uma `Promise` de verdade, com os elos pendurados nela, e não um objeto com
 * um `then` escrito à mão: o PostgREST se resolve tanto ao ser aguardado
 * direto (`await from(…).select(…).eq(…)`) quanto por `maybeSingle()`, e as
 * duas formas aparecem no código que estes testes atravessam.
 */
function consultaEncadeavel(resposta: RespostaPostgrest) {
  const pendente = Promise.resolve(resposta);
  const encadeada = pendente as Promise<RespostaPostgrest> & Record<string, unknown>;
  for (const elo of ELOS_DA_CONSULTA) {
    encadeada[elo] = () => encadeada;
  }
  encadeada.maybeSingle = () => pendente;
  encadeada.single = () => pendente;
  return encadeada;
}

/**
 * Cenário de identidade e vínculo de uma requisição.
 *
 * Um por arquivo de teste. O `supabaseServer` que ele expõe entra no
 * `vi.mock('@/lib/supabaseServer', …)`, e os métodos abaixo mudam o cenário
 * entre um caso e outro.
 */
export class FronteiraDeAutorizacao {
  private identidade: RespostaDoProvedor = { data: { user: null }, error: { message: 'sem sessão', status: 401 } };
  private contextoAtivo: RespostaPostgrest = { data: null, error: null };
  private vinculo: RespostaPostgrest = { data: null, error: null };
  /** Tabelas consultadas pelo handler depois da autorização, e o que devolver. */
  private readonly tabelas = new Map<string, RespostaPostgrest>();
  /** RPCs chamadas pelo handler depois da autorização, e o que devolver. */
  private readonly rpcs = new Map<string, RespostaPostgrest>();

  /** Sessão válida do ator. O provedor confirma a identidade, e nada além dela. */
  sessaoDe(userId: string): this {
    this.identidade = {
      data: { user: { id: userId, app_metadata: { provider: 'email', providers: ['email'] } } },
      error: null,
    };
    return this;
  }

  /** Token presente e recusado pelo provedor — a origem do 401 que não é ausência. */
  sessaoInvalida(): this {
    this.identidade = { data: { user: null }, error: { message: 'invalid claim: bad jwt', status: 401 } };
    return this;
  }

  /** Provedor de identidade fora do ar: a resposta certa é 503, não 401. */
  provedorDeIdentidadeIndisponivel(): this {
    this.identidade = { data: { user: null }, error: { message: 'upstream', status: 503, code: 'auth_unavailable' } };
    return this;
  }

  /** Vínculo persistido do ator com a organização indicada. */
  vinculoDe(papel: PapelDeTeste, organizacaoId: string = ORG_ID): this {
    this.vinculo = linhaDeVinculo(papel, organizacaoId);
    return this;
  }

  /** Identidade válida, nenhum vínculo — a origem do 403 que não é 401. */
  semVinculo(): this {
    this.vinculo = { data: null, error: null };
    return this;
  }

  /** Depósito de vínculos indisponível: 503, e nunca 403. */
  depositoDeVinculosIndisponivel(): this {
    this.vinculo = { data: null, error: { code: 'XX000', message: 'connection reset' } };
    return this;
  }

  /** Resposta de uma tabela que o handler consulta **depois** da autorização. */
  tabela(nome: string, resposta: RespostaPostgrest): this {
    this.tabelas.set(nome, resposta);
    return this;
  }

  /** Resposta de uma RPC chamada pelo handler depois da autorização. */
  rpcResponde(nome: string, resposta: RespostaPostgrest): this {
    this.rpcs.set(nome, resposta);
    return this;
  }

  /**
   * As RPCs chamadas, na ordem, com os argumentos recebidos.
   *
   * É por aqui que um teste confere que a organização enviada ao banco veio do
   * vínculo, e não de um campo do corpo da requisição.
   */
  readonly chamadasDeRpc: { nome: string; argumentos: Record<string, unknown> }[] = [];

  /** Esquece o que foi chamado, preservando o cenário. */
  limparChamadas(): this {
    this.chamadasDeRpc.length = 0;
    return this;
  }

  /** O que a tabela consultada deve devolver, no cenário atual. */
  private respostaDaTabela(tabela: string): RespostaPostgrest {
    if (tabela === 'contextos_organizacao_ativos') return this.contextoAtivo;
    if (tabela === 'membros_organizacao') return this.vinculo;
    return this.tabelas.get(tabela) ?? { data: null, error: null };
  }

  /**
   * O substituto de `supabaseServer`.
   *
   * A cadeia reproduz o formato que o repositório de vínculos usa: contexto
   * ativo por `user_id`, depois o vínculo com a organização embutida, com
   * `order`/`limit` quando não há contexto ativo persistido.
   *
   * As funções são setas de propósito: elas capturam `this` do próprio getter,
   * o que dispensa apelidar a instância.
   */
  get supabaseServer() {
    return {
      auth: {
        getUser: async (): Promise<RespostaDoProvedor> => this.identidade,
      },
      rpc: async (nome: string, argumentos: Record<string, unknown>): Promise<RespostaPostgrest> => {
        this.chamadasDeRpc.push({ nome, argumentos });
        return this.rpcs.get(nome) ?? { data: null, error: null };
      },
      from: (tabela: string) => consultaEncadeavel(this.respostaDaTabela(tabela)),
    };
  }
}

/** Requisição HTTP para uma rota, com ou sem o bearer da sessão. */
export function requisicao(
  url: string,
  opcoes: { metodo?: string; autorizada?: boolean; corpo?: unknown } = {},
): Request {
  const { metodo = 'GET', autorizada = true, corpo } = opcoes;
  return new Request(url, {
    method: metodo,
    headers: {
      ...(autorizada ? { Authorization: 'Bearer token-de-sessao' } : {}),
      'Content-Type': 'application/json',
    },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
}
