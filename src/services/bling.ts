import { BlingPedido, BlingCliente, BlingProduto, BlingCategoria } from '../types';
import { supabaseServer } from '../lib/supabaseServer';
import { credentialsVault } from '../lib/integrations/credentialsVault';
import { refreshBlingToken } from './blingOAuth';
import type { VerifiedOrganizationScope } from '../lib/verifiedOrganizationScope';
import { descreverErro } from '../lib/erroLegivel';
import type {
  BlingPort,
  ContaPagarBlingEntrada,
  ContatoBlingEntrada,
  ProdutoBlingEntrada,
} from './blingPort';
import {
  blingFailure,
  parseBlingFailure,
  pedidoVendaCreatedSchema,
  type BlingCallResult,
  type PedidoVendaPayload,
} from '../lib/integrations/bling/pedidoVendaContract';
import {
  encontrarModuloDePedidosDeVenda,
  encontrarSituacaoDeCancelamento,
  lerModulos,
  lerSituacoes,
  type Situacao,
} from '../lib/integrations/bling/situacoesContract';
import { registrarFalhaInterna } from '../lib/observability/falhaInterna';
import { FilaDeRequisicoes, esperar, type Dormir } from './filaDeRequisicoes';


/**
 * As peças externas que o cliente usa antes de falar HTTP com o Bling.
 *
 * Existe para que os testes possam exercitar o `getAccessToken` **real** sem
 * mock de módulo — a convenção deste repositório é porta injetada, como
 * `BlingPort` e `ManualOrderStorePort`. Sem isto, provar o caminho do token
 * exigia dublar o próprio método, e a prova desviava justamente da linha em
 * questão.
 */
export interface PortasDoClienteBling {
  /** Espera cancelável usada no backoff de 429. */
  readonly dormir: Dormir;
  /** Id da conexão Bling da organização, ou `null` quando não há. */
  readonly acharConexaoId: (organizacaoId: string) => Promise<string | null>;
  /** Credenciais decifradas da conexão. */
  readonly lerCredenciais: (
    organizacaoId: string,
    conexaoId: string,
  ) => Promise<Record<string, unknown> | null>;
}

const PORTAS_REAIS: PortasDoClienteBling = {
  dormir: esperar,
  acharConexaoId: async (organizacaoId) => {
    const { data } = await supabaseServer
      .from('conexoes_integracao')
      .select('id')
      .eq('organizacao_id', organizacaoId)
      .eq('provedor', 'bling')
      .maybeSingle();
    return data?.id ?? null;
  },
  lerCredenciais: (organizacaoId, conexaoId) =>
    credentialsVault.getDecryptedCredentials(organizacaoId, conexaoId) as Promise<Record<string, unknown> | null>,
};

const orgClientCache = new Map<string, BlingClient>();



/**
 * Frase pública para uma falha HTTP do Bling, derivada **só do status**.
 *
 * Vocabulário fechado, escrito aqui: nada do corpo da resposta do provedor
 * chega ao usuário — e **nada dele vai para o log tampouco**. O corpo sequer é
 * lido: `falhaPublicaDoBling` cancela o fluxo da resposta. Uma versão anterior
 * deste comentário dizia que ele "vai inteiro para o log", e era falso duas
 * vezes: `registrarFalhaInterna` grava a classe do erro, não o conteúdo, e o
 * texto nunca chega até lá.
 *
 * O status entra na frase de propósito — é número, não texto de terceiro, e é
 * o que permite alguém correlacionar a queixa com o log, onde ele aparece no
 * rótulo da operação.
 */
function mensagemPublicaDeStatusDoBling(status: number, oQue: string): string {
  if (status === 404) {
    return `O Bling não encontrou o recurso necessário para ${oQue} (HTTP 404).`;
  }
  if (status === 429) {
    return `O Bling está limitando as requisições no momento (HTTP 429), e por isso não deu para ${oQue}. `
      + 'Tente de novo em alguns instantes.';
  }
  if (status >= 500) {
    return `O Bling está indisponível no momento (HTTP ${status}), e por isso não deu para ${oQue}. `
      + 'Tente de novo em alguns instantes.';
  }
  if (status === 401 || status === 403) {
    return `O Bling recusou o acesso necessário para ${oQue}. Reconecte a conta em "Conectar APIs".`;
  }
  return `O Bling recusou ${oQue} (HTTP ${status}).`;
}

/**
 * Corpo de `POST`/`PUT /produtos`, com os quatro obrigatorios do OpenAPI
 * oficial (`nome`, `tipo`, `situacao`, `formato`). `codigo` so entra quando
 * informado — o SKU nunca e inventado — e `estoque` nunca entra: no schema
 * oficial ele e um objeto cujo saldo e `readOnly`.
 */
function corpoProdutoBling(payload: ProdutoBlingEntrada): Record<string, unknown> {
  const corpo: Record<string, unknown> = {
    nome: payload.nome,
    preco: payload.preco,
    tipo: payload.tipo,
    situacao: payload.situacao,
    formato: payload.formato,
    unidade: payload.unidade,
  };
  if (payload.codigo) corpo.codigo = payload.codigo;
  if (payload.formato === 'S') corpo.variacoes = [];
  return corpo;
}

/**
 * Erro de leitura do Bling.
 *
 * Existe porque os metodos de listagem devolviam `[]` em qualquer falha —
 * 401, 403, 500, timeout — tornando "o provedor recusou" indistinguivel de
 * "nao ha nada". Numa sincronizacao isso e desastroso: a etapa "conclui" com
 * zero itens, o checkpoint avanca para agora, e as execucoes seguintes filtram
 * por `dataAlteracaoInicial` a partir do momento da falha. O erro some e nunca
 * mais volta sozinho.
 *
 * Quem realmente quiser degradar para lista vazia agora precisa dizer isso no
 * ponto da chamada.
 */
export class BlingLeituraError extends Error {
  readonly status: number;

  constructor(recurso: string, status: number, detalhe: string) {
    super(`Falha ao ler ${recurso} no Bling (HTTP ${status}): ${detalhe}`);
    this.name = 'BlingLeituraError';
    this.status = status;
  }
}

export class BlingClient implements BlingPort {
  /**
   * Teto de uma **operação** conduzida por `comOrcamento`, do começo ao fim.
   *
   * Não é o teto de uma requisição: cobre todas as que a operação fizer, mais
   * as esperas entre elas. Hoje são duas operações, e a maior tem três
   * requisições — as duas leituras da descoberta e o `PATCH` que cancela o
   * pedido. O nome anterior dizia "situações" e descrevia só a primeira.
   *
   * Generoso de propósito: `enforceRateLimit` espaça as requisições em 340 ms,
   * o backoff de 429 pode somar segundos, e um teto apertado transformaria
   * lentidão em falha justamente no caminho da compensação, que é o que não
   * pode falhar por pressa.
   */
  static readonly TEMPO_LIMITE_OPERACAO_MS = 20_000;

  private baseUrl = process.env.BLING_API_BASE_URL || 'https://api.bling.com.br/Api/v3';
  private oauthUrl = process.env.BLING_OAUTH_URL || 'https://www.bling.com.br/Api/v3/oauth/token';

  private refreshTokenPromise: Promise<string> | null = null;
  private readonly fila: FilaDeRequisicoes;

  private readonly organizacaoId?: string;
  private conexaoId?: string;
  private readonly portas: PortasDoClienteBling;

  private constructor(organizacaoId?: string, conexaoId?: string, portas: PortasDoClienteBling = PORTAS_REAIS) {
    this.organizacaoId = organizacaoId;
    this.conexaoId = conexaoId;
    this.portas = portas;
    this.fila = new FilaDeRequisicoes({ dormir: portas.dormir });
  }

  /**
   * Cliente com portas trocadas, **sem cache**.
   *
   * O cache existe para reaproveitar token entre chamadas da mesma organização;
   * um cliente com portas próprias não é o mesmo cliente, e guardá-lo lá
   * contaminaria quem pedisse o normal depois.
   */
  static comPortas(organizacaoId: string, portas: Partial<PortasDoClienteBling>): BlingClient {
    return new BlingClient(organizacaoId, undefined, { ...PORTAS_REAIS, ...portas });
  }

  /**
   * Cliente Bling da organizacao ja provada contra a associacao persistida.
   *
   * Substitui `forUser(tenant)`, removido no Ticket 10b. Exigir o escopo
   * verificado no tipo torna impossivel chamar o Bling sem uma organizacao
   * autorizada — antes bastava um `user_id` de sessao, e a credencial vinha de
   * uma tabela que o `service_role` nem consegue ler.
   */
  static forVerifiedOrganization(scope: VerifiedOrganizationScope, conexaoId?: string): BlingClient {
    return BlingClient.forOrganization(scope.organizationId, conexaoId);
  }

  static forOrganization(organizacaoId: string, conexaoId?: string): BlingClient {
    const key = `${organizacaoId}:${conexaoId || 'primary'}`;
    let c = orgClientCache.get(key);
    if (!c) {
      c = new BlingClient(organizacaoId, conexaoId);
      orgClientCache.set(key, c);
    }
    return c;
  }

  // Renovação forçada de token OAuth v3 junto ao Bling
  /**
   * Renova o token OAuth da conexao Bling da organizacao.
   *
   * O caminho por `user_id` sobre `integracoes_bling` foi removido no Ticket
   * 10b: `service_role` nao tem privilegio nenhum naquela tabela (comprovado
   * com `set local role service_role` no laboratorio e no staging), entao toda
   * chamada interativa do Bling falhava com `42501 permission denied` antes de
   * chegar ao provedor. A credencial agora vem sempre do cofre por
   * organizacao criado no Ticket 28.
   */
  async forceRefreshToken(): Promise<string> {
    if (!this.organizacaoId) {
      throw new Error('Organizacao verificada e obrigatoria para operacoes com o Bling.');
    }
    return await this._forceRefreshTokenForOrg();
  }

  private async _forceRefreshTokenForOrg(): Promise<string> {
    if (!this.organizacaoId) {
      throw new Error('OrganizacaoId é obrigatório.');
    }

    // Localizar conexao_id se não especificado
    if (!this.conexaoId) {
      const { data: conn } = await supabaseServer
        .from('conexoes_integracao')
        .select('id')
        .eq('organizacao_id', this.organizacaoId)
        .eq('provedor', 'bling')
        .maybeSingle();

      if (conn?.id) {
        this.conexaoId = conn.id;
      }
    }

    if (!this.conexaoId) {
      throw new Error('Nenhuma conexao Bling encontrada para esta organizacao.');
    }

    const { data: lockAcquired, error: lockError } = await supabaseServer
      .rpc('acquire_conexao_token_lock', {
        p_conexao_id: this.conexaoId,
        p_timeout_seconds: 30,
      });

    if (lockError) {
      console.error('Erro ao adquirir lock de conexao Bling:', lockError);
    }

    if (!lockAcquired) {
      // Polling aguardando liberação
      for (let i = 0; i < 15; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const creds = await credentialsVault.getDecryptedCredentials(this.organizacaoId, this.conexaoId);
        if (creds?.access_token && creds?.token_expires_at) {
          if (new Date() < new Date(creds.token_expires_at as string)) {
            return creds.access_token as string;
          }
        }
      }
      throw new Error('Timeout esperando outro processo renovar token Bling da organizacao.');
    }

    try {
      const creds = await credentialsVault.getDecryptedCredentials(this.organizacaoId, this.conexaoId);
      if (!creds?.client_id || !creds?.client_secret || !creds?.refresh_token) {
        throw new Error('Credenciais Bling incompletas no cofre da organizacao.');
      }

      const refreshResult = await refreshBlingToken({
        clientId: creds.client_id as string,
        clientSecret: creds.client_secret as string,
        refreshToken: creds.refresh_token as string,
      });

      if (refreshResult._tag === 'BlingOAuthTokenExchangeFailed') {
        throw new Error(`Falha ao renovar token Bling: ${refreshResult.reason}`);
      }

      const newExpiresAt = new Date(Date.now() + refreshResult.expires_in * 1000).toISOString();

      await credentialsVault.saveEncryptedCredentials(this.organizacaoId, this.conexaoId, {
        client_id: creds.client_id,
        client_secret: creds.client_secret,
        access_token: refreshResult.access_token,
        refresh_token: refreshResult.refresh_token,
        token_expires_at: newExpiresAt,
      });

      return refreshResult.access_token;
    } finally {
      await supabaseServer.rpc('release_conexao_token_lock', {
        p_conexao_id: this.conexaoId,
      });
    }
  }

  // `_doForceRefreshToken` (renovacao por `user_id` em `integracoes_bling`) foi
  // removido no Ticket 10b junto com o ultimo chamador.

  /**
   * Access token valido da conexao Bling **da organizacao**.
   *
   * O caminho legado lia `integracoes_bling` por `user_id`. Ele foi removido no
   * Ticket 10b por dois motivos independentes, cada um suficiente:
   *
   * 1. `service_role` nao tem privilegio algum naquela tabela — comprovado com
   *    `set local role service_role; select 1 from public.integracoes_bling`,
   *    que devolve `42501 permission denied` tanto no laboratorio quanto no
   *    staging. Toda rota interativa do Bling morria ali.
   * 2. O Ticket 28 tornou a conexao do Bling **por organizacao**. Manter uma
   *    segunda fonte de credencial, por usuario, e a mesma configuracao que
   *    produziu os bugs dos tickets 26, 27 e 28: dois lados coerentes consigo
   *    mesmos e divergentes entre si.
   */
  private async getAccessToken(signal?: AbortSignal): Promise<string> {
    if (!this.organizacaoId) {
      throw new Error('Organizacao verificada e obrigatoria para operacoes com o Bling.');
    }

    if (!this.conexaoId) {
      this.conexaoId = (await this.portas.acharConexaoId(this.organizacaoId)) ?? undefined;
    }

    if (!this.conexaoId) {
      throw new Error('Bling nao conectado para esta organizacao. Conclua os passos 1 e 2 em Integracoes.');
    }

    // A consulta da conexão acima também consome tempo, e pode ter estourado o
    // orçamento sozinha. Sem esta conferência, a leitura do cofre — outra ida à
    // rede — começaria já fora do prazo.
    signal?.throwIfAborted();

    const creds = await this.portas.lerCredenciais(this.organizacaoId, this.conexaoId);
    if (!creds?.access_token) {
      throw new Error('Bling nao conectado para esta organizacao. Conclua os passos 1 e 2 em Integracoes.');
    }

    if (creds.token_expires_at && new Date() >= new Date(creds.token_expires_at as string)) {
      // Caminho inicial de token vencido: a renovação começa aqui, antes de
      // qualquer requisição. A leitura do cofre acima pode ter consumido o
      // orçamento inteiro, e começar um polling de lock já fora do prazo é o
      // pior gasto possível.
      signal?.throwIfAborted();
      return await this.forceRefreshToken();
    }

    return creds.access_token as string;
  }

  /** Espaça as requisições ao Bling. Ver `FilaDeRequisicoes`. */
  private async enforceRateLimit(signal?: AbortSignal): Promise<void> {
    await this.fila.aguardarVez(signal);
  }

  // Fetch autenticado com auto-refresh em caso de 401 Unauthorized
  // Fetch autenticado com auto-refresh em caso de 401 Unauthorized e retry em caso de 429
  private async fetchWithAuth(url: string, options: RequestInit = {}): Promise<Response> {
    // Quem passa `signal` está sob orçamento de tempo (ver `comOrcamento`).
    //
    // O que estas conferências garantem, exatamente: nenhuma **requisição
    // nova**, nenhuma leitura de credencial nova e nenhuma tentativa nova
    // começam depois do prazo, e as duas esperas puramente temporais — fila do
    // rate limit e backoff de 429 — são interrompidas no meio.
    //
    // O que elas **não** garantem: uma renovação de token já iniciada segue até
    // o fim, porque `forceRefreshToken` faz *polling* de lock com `await` de
    // banco, que não é cancelável. Esse é o resíduo conhecido.
    options.signal?.throwIfAborted();

    let token = await this.getAccessToken(options.signal ?? undefined);
    let retries = 0;

    while (retries < 2) {
      options.signal?.throwIfAborted();
      await this.enforceRateLimit(options.signal ?? undefined);

      const response = await fetch(url, {
        ...options,
        headers: {
          ...options.headers,
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/json',
          'enable-jwt': '1',
        },
      });

      if (response.status === 429) {
        // Conferir **antes** de entrar no backoff: sem isto, uma chamada já
        // fora do prazo dormia o intervalo inteiro só para descobrir na volta
        // que não deveria ter esperado.
        options.signal?.throwIfAborted();
        retries++;
        const retryAfter = parseInt(response.headers.get('Retry-After') || '1', 10);
        console.warn(`⚠️ Rate Limit atingido (HTTP 429). Aguardando retry com backoff...`);
        await this.portas.dormir(retryAfter * 1000 * Math.pow(2, retries - 1), options.signal ?? undefined);
        continue;
      }

      if ((response.status === 401 || response.status === 403) && retries === 0) {
        // A renovação é o passo mais caro e o **menos** interrompível: ela faz
        // polling de lock com `await` de banco. Começar uma já fora do prazo é
        // o pior gasto possível, e é o único ponto onde ainda dá para evitar.
        options.signal?.throwIfAborted();
        console.warn(`⚠️ Bling v3 retornou HTTP ${response.status}. Renovando token OAuth v3 para atualizar escopos/permissões...`);
        try {
          token = await this.forceRefreshToken();
          retries++;
          continue;
        } catch (err: unknown) {
          const errMessage = descreverErro(err);
          console.error('❌ BlingClient: Falha na renovação automática do token Bling OAuth v3:', errMessage);
          if (errMessage === 'BLING_INVALID_GRANT') {
            throw new Error('BLING_INVALID_GRANT');
          }
          throw new Error(
            `Conexão Bling OAuth v3 (HTTP ${response.status}): ${errMessage || 'Token expirado/sem permissão'}. Se você alterou permissões recentemente no Bling, por favor, clique em 'Conectar APIs' no topo da tela para reautorizar.`
          );
        }
      }

      return response;
    }

    throw new Error('Número máximo de retries excedido (HTTP 429 Too Many Requests).');
  }

  // Ping rápido para verificar se a API está conectada e com token válido
  async ping(): Promise<boolean> {
    try {
      const response = await this.fetchWithAuth(`${this.baseUrl}/produtos?limite=1`);
      return response.ok;
    } catch (err: unknown) {
      const errMessage = descreverErro(err);
      if (errMessage === 'BLING_INVALID_GRANT') {
        throw err;
      }
      console.warn('Erro ao testar ping com a API do Bling:', errMessage);
      return false;
    }
  }

  // Obter pedidos recentes do Bling com paginação e data de corte
  async getPedidos(pagina = 1, limite = 100, dataInicial?: string): Promise<BlingPedido[]> {
    try {
      const url = new URL(`${this.baseUrl}/pedidos/vendas`);
      url.searchParams.append('pagina', pagina.toString());
      url.searchParams.append('limite', limite.toString());
      if (dataInicial) {
        url.searchParams.append('dataInicial', dataInicial);
      }

      const response = await this.fetchWithAuth(url.toString());

      if (!response.ok) {
        throw new BlingLeituraError('pedidos', response.status, await response.text());
      }

      const data = await response.json();
      return (data.data && Array.isArray(data.data)) ? data.data : [];
    } catch (error: unknown) {
      if (error instanceof BlingLeituraError) throw error;
      throw new BlingLeituraError('pedidos', 0, descreverErro(error));
    }
  }

  /**
   * Detalhes de um pedido específico — a única fonte de `itens`, que a
   * listagem não devolve.
   *
   * `null` significa **não existe** (404), e só isso. Antes, qualquer falha
   * — rede caída, token expirado, 500 do Bling — também virava `null`, e a
   * sincronização lia isso como "pedido sem itens" e seguia em frente
   * gravando um pedido vazio. Um erro de leitura não pode ser indistinguível
   * de um pedido inexistente.
   */
  async getPedido(id: string): Promise<BlingPedido | null> {
    try {
      const response = await this.fetchWithAuth(`${this.baseUrl}/pedidos/vendas/${id}`);
      if (response.status === 404) return null;
      if (!response.ok) {
        throw new BlingLeituraError('pedido', response.status, await response.text());
      }
      const resData = await response.json();
      return resData.data || null;
    } catch (error: unknown) {
      if (error instanceof BlingLeituraError) throw error;
      throw new BlingLeituraError('pedido', 0, descreverErro(error));
    }
  }

  // Obter contatos/clientes do Bling com paginação
  async getClientes(pagina = 1, limite = 100, dataAlteracaoInicial?: string): Promise<BlingCliente[]> {
    try {
      const url = new URL(`${this.baseUrl}/contatos`);
      url.searchParams.append('pagina', pagina.toString());
      url.searchParams.append('limite', limite.toString());
      if (dataAlteracaoInicial) {
        url.searchParams.append('dataAlteracaoInicial', dataAlteracaoInicial);
      }

      const response = await this.fetchWithAuth(url.toString());

      if (!response.ok) {
        throw new BlingLeituraError('contatos', response.status, await response.text());
      }

      const data = await response.json();
      return (data.data && Array.isArray(data.data)) ? data.data : [];
    } catch (error: unknown) {
      if (error instanceof BlingLeituraError) throw error;
      throw new BlingLeituraError('contatos', 0, descreverErro(error));
    }
  }

  // Obter contatos filtrados por nome (tenta pesquisa na API, faz fallback local)
  async getContatosByNome(nome: string): Promise<BlingCliente[]> {
    try {
      // Bling v3 aceita 'pesquisa' como filtro parcial de nome
      const url = new URL(`${this.baseUrl}/contatos`);
      url.searchParams.append('pesquisa', nome);
      url.searchParams.append('limite', '50');
      const response = await this.fetchWithAuth(url.toString());
      if (!response.ok) {
        console.warn('[getContatosByNome] Erro HTTP:', response.status);
        return [];
      }
      const data = await response.json();
      const lista = (data.data && Array.isArray(data.data)) ? data.data : [];
      console.log(`[getContatosByNome] Busca por "${nome}": ${lista.length} resultado(s)`);
      return lista;
    } catch (error: unknown) {
      const errorMsg = descreverErro(error);
      console.warn('[getContatosByNome] Exceção:', errorMsg);
      return [];
    }
  }

  // Obter produtos do Bling com paginação
  async getProdutos(pagina = 1, limite = 100, codigo?: string, dataAlteracaoInicial?: string): Promise<BlingProduto[]> {
    try {
      const url = new URL(`${this.baseUrl}/produtos`);
      url.searchParams.append('pagina', pagina.toString());
      url.searchParams.append('limite', limite.toString());
      // `codigos[]` e o filtro documentado por SKU no OpenAPI oficial. Antes o
      // codigo ia como `codigo`, parametro que NAO existe em `GET /produtos`:
      // o Bling o ignorava e devolvia o primeiro produto da conta, que o
      // chamador entao tratava como "ja existe" e sobrescrevia com PUT. Ver
      // `buscarProdutoPorCodigo`, que confere o resultado antes de confiar.
      if (codigo) url.searchParams.append('codigos[]', codigo);
      if (dataAlteracaoInicial) {
        url.searchParams.append('dataAlteracaoInicial', dataAlteracaoInicial);
      }

      const response = await this.fetchWithAuth(url.toString());

      if (!response.ok) {
        throw new BlingLeituraError('produtos', response.status, await response.text());
      }

      const data = await response.json();
      return (data.data && Array.isArray(data.data)) ? data.data : [];
    } catch (error: unknown) {
      if (error instanceof BlingLeituraError) throw error;
      throw new BlingLeituraError('produtos', 0, descreverErro(error));
    }
  }

  /**
   * Busca um produto pelo SKU exato, conferindo o `codigo` do resultado.
   *
   * A conferencia existe porque um filtro ignorado pelo provedor devolve uma
   * lista qualquer, e confiar nela ja causou o pior tipo de bug: cadastrar um
   * produto novo disparava um PUT sobrescrevendo nome, codigo e preco de um
   * produto nao relacionado, seguido de um lancamento de saldo absoluto nele.
   * Um filtro que nao filtra nunca mais pode virar escrita destrutiva.
   */
  async buscarProdutoPorCodigo(codigo: string): Promise<BlingProduto | null> {
    const alvo = codigo.trim();
    if (!alvo) return null;

    const encontrados = await this.getProdutos(1, 50, alvo);
    const exato = encontrados.find((produto) => String(produto.codigo ?? '').trim() === alvo);
    return exato ?? null;
  }

  // Obter categorias de produtos do Bling
  async getCategoriasProdutos(pagina = 1, limite = 100): Promise<BlingCategoria[]> {
    try {
      const url = new URL(`${this.baseUrl}/categorias/produtos`);
      url.searchParams.append('pagina', pagina.toString());
      url.searchParams.append('limite', limite.toString());

      const response = await this.fetchWithAuth(url.toString());

      if (!response.ok) {
        throw new BlingLeituraError('categorias de produtos', response.status, await response.text());
      }

      const data = await response.json();
      return (data.data && Array.isArray(data.data)) ? data.data : [];
    } catch (error: unknown) {
      const errorMsg = descreverErro(error);
      console.warn('⚠️ BlingClient: Erro ao buscar categorias do Bling:', errorMsg);
      return [];
    }
  }

  // Obter detalhes completos de um produto no Bling (incluindo imagens e estoque)
  async getProduto(id: string): Promise<BlingProduto | null> {
    try {
      const response = await this.fetchWithAuth(`${this.baseUrl}/produtos/${id}`);
      if (!response.ok) return null;
      const resData = await response.json();
      return resData.data || null;
    } catch {
      return null;
    }
  }

  // Deletar um produto no Bling ERP
  async deleteProduto(id: string): Promise<unknown> {
    const url = `${this.baseUrl}/produtos/${id}`;
    const response = await this.fetchWithAuth(url, {
      method: 'DELETE',
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Erro na API Bling ao deletar produto (HTTP ${response.status}): ${errorText}`);
    }

    return { success: true };
  }

  // Obter saldos de estoque físicos de múltiplos produtos
  async getEstoquesSaldos(idsProdutos: string[]): Promise<unknown[]> {
    if (!idsProdutos.length) return [];
    try {
      const url = new URL(`${this.baseUrl}/estoques/saldos`);
      idsProdutos.forEach(id => url.searchParams.append('idsProdutos[]', id));

      const response = await this.fetchWithAuth(url.toString());
      if (!response.ok) {
        throw new BlingLeituraError('saldos de estoque', response.status, await response.text());
      }
      const data = await response.json();
      return (data.data && Array.isArray(data.data)) ? data.data : [];
    } catch (error: unknown) {
      if (error instanceof BlingLeituraError) throw error;
      throw new BlingLeituraError('saldos de estoque', 0, descreverErro(error));
    }
  }

  // Lançamento de estoque (Operação 'B' define saldo físico absoluto)
  private async lancamentoEstoque(idProduto: string, quantidade: number, operacao: string = 'B'): Promise<unknown> {
    const depositosRes = await this.fetchWithAuth(`${this.baseUrl}/depositos`);
    if (!depositosRes.ok) {
      const errText = await depositosRes.text();
      throw new Error(`Falha ao buscar depósitos (HTTP ${depositosRes.status}): ${errText}`);
    }
    const depositos = await depositosRes.json();
    const defaultDeposit = (depositos.data as Array<{ id: number; padrao?: boolean }>)?.find(d => d.padrao) || (depositos.data as Array<{ id: number; padrao?: boolean }>)?.[0];

    if (!defaultDeposit) throw new Error('Nenhum depósito encontrado na conta Bling.');

    const url = `${this.baseUrl}/estoques`;
    const bodyPayload = {
      produto: { id: Number(idProduto) },
      deposito: { id: defaultDeposit.id },
      operacao,
      quantidade
    };

    const response = await this.fetchWithAuth(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyPayload),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Erro na API Bling ao lançar estoque (HTTP ${response.status}): ${errText}`);
    }

    return await response.json();
  }

  // Emitir Nota Fiscal (NF-e) para um pedido no Bling v3
  async emitirNfe(pedidoId: string): Promise<unknown> {
    const url = `${this.baseUrl}/nfe`;
    const response = await this.fetchWithAuth(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        pedido: { id: pedidoId }
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Erro na API Bling ao emitir NF-e (${response.status}): ${errText}`);
    }

    return await response.json();
  }

  async createNfe(pedidoId: string): Promise<unknown> {
    return this.emitirNfe(pedidoId);
  }

  // Criar um novo contato no Bling ERP v3
  // Campos obrigatórios: nome, tipo, contribuinte
  /**
   * `POST /contatos`.
   *
   * Os nomes de campo aqui sao os do OpenAPI oficial: `telefone` e
   * `indicadorIe`. Ate o ticket 06 este metodo mandava `fone` e `contribuinte`,
   * que **nao existem** na API — o Bling aceitava a requisicao e descartava os
   * dois em silencio, entao todo contato criado pela venda manual e pelo
   * cadastro de fornecedor nascia sem telefone e sem indicador de IE. Havia
   * ate um comentario no codigo afirmando que `fone` era o nome correto.
   *
   * O `ClienteEditModal` ja tinha sido corrigido; este caminho nao.
   */
  async createContato(payload: { nome: string; email?: string; telefone?: string; cnpj?: string; tipo?: string; indicadorIe?: number; cep?: string; endereco?: string; numero?: string; bairro?: string; cidade?: string; uf?: string }): Promise<unknown> {
    const url = `${this.baseUrl}/contatos`;
    const bodyPayload: Record<string, unknown> = {
      nome: payload.nome,
      situacao: 'A',
      tipo: payload.tipo || 'F',           // F = Pessoa Física (padrão)
      indicadorIe: payload.indicadorIe !== undefined ? payload.indicadorIe : 9,     // 9 = Não contribuinte ICMS (padrão seguro)
    };

    // Campos opcionais — só adicionar se tiverem valor
    if (payload.email) bodyPayload.email = payload.email;
    if (payload.telefone) bodyPayload.telefone = payload.telefone;

    if (payload.cnpj) {
      bodyPayload.numeroDocumento = payload.cnpj;
      // Se CNPJ tem 14 dígitos e UI não enviou explicitamente, inferir
      if (!payload.tipo || payload.indicadorIe === undefined) {
        const cleanDoc = payload.cnpj.replace(/\D/g, '');
        if (cleanDoc.length === 14) {
          if (!payload.tipo) bodyPayload.tipo = 'J';
          if (payload.indicadorIe === undefined) bodyPayload.indicadorIe = 1; // Contribuinte ICMS
        }
      }
    }

    // Endereço
    const enderecoPayload: Record<string, unknown> = {};
    let hasEndereco = false;
    if (payload.cep) { enderecoPayload.cep = payload.cep; hasEndereco = true; }
    if (payload.endereco) { enderecoPayload.endereco = payload.endereco; hasEndereco = true; }
    if (payload.numero) { enderecoPayload.numero = payload.numero; hasEndereco = true; }
    if (payload.bairro) { enderecoPayload.bairro = payload.bairro; hasEndereco = true; }
    if (payload.cidade) { enderecoPayload.municipio = payload.cidade; hasEndereco = true; } // municipio no bling
    if (payload.uf) { enderecoPayload.uf = payload.uf; hasEndereco = true; }

    if (hasEndereco) {
      bodyPayload.endereco = {
        geral: enderecoPayload
      };
    }

    const response = await this.fetchWithAuth(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyPayload),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Erro na API Bling ao criar contato (HTTP ${response.status}): ${errText}`);
    }

    return await response.json();
  }

  // ── Contatos com contrato oficial e falha tipada (Ticket 32) ───────────

  /**
   * Corpo de `POST`/`PUT /contatos` conforme o OpenAPI oficial.
   *
   * Duas correcoes do Ticket 32, ambas de campo que **nao existe** no schema e
   * por isso era descartado em silencio pelo provedor:
   *
   * - o telefone ia como `fone`; o campo e `telefone`;
   * - o indicador de ICMS ia como `contribuinte`; o campo e `indicadorIe`
   *   (`1` contribuinte, `2` isento, `9` nao contribuinte).
   *
   * O endereco fica sob `endereco.geral`, que ja estava correto.
   */
  private corpoContatoBling(payload: ContatoBlingEntrada): Record<string, unknown> {
    const corpo: Record<string, unknown> = {
      nome: payload.nome,
      situacao: 'A',
      tipo: payload.tipo,
      indicadorIe: payload.indicadorIe,
    };

    if (payload.email) corpo.email = payload.email;
    if (payload.telefone) corpo.telefone = payload.telefone;
    if (payload.numeroDocumento) corpo.numeroDocumento = payload.numeroDocumento;

    const geral: Record<string, unknown> = {};
    if (payload.cep) geral.cep = payload.cep;
    if (payload.endereco) geral.endereco = payload.endereco;
    if (payload.numero) geral.numero = payload.numero;
    if (payload.bairro) geral.bairro = payload.bairro;
    if (payload.cidade) geral.municipio = payload.cidade;
    if (payload.uf) geral.uf = payload.uf;
    if (Object.keys(geral).length > 0) corpo.endereco = { geral };

    return corpo;
  }

  /** Cria o contato e devolve o id real, com falha tipada. */
  async criarContato(payload: ContatoBlingEntrada): Promise<BlingCallResult<{ id: string }>> {
    const response = await this.fetchWithAuth(`${this.baseUrl}/contatos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(this.corpoContatoBling(payload)),
    });

    if (!response.ok) {
      return { _tag: 'BlingFailed', failure: parseBlingFailure(response.status, await response.text()) };
    }

    const body = (await response.json()) as { data?: { id?: number | string } };
    const id = body?.data?.id;
    if (id === undefined || id === null || String(id).trim() === '') {
      return blingFailure('INVALID_RESPONSE', response.status, 'O Bling respondeu sucesso sem informar o ID do contato criado.');
    }

    return { _tag: 'BlingOk', value: { id: String(id) } };
  }

  /** Atualiza o contato existente, com falha tipada. */
  async atualizarContato(id: string, payload: ContatoBlingEntrada): Promise<BlingCallResult<void>> {
    const response = await this.fetchWithAuth(`${this.baseUrl}/contatos/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(this.corpoContatoBling(payload)),
    });

    if (!response.ok) {
      return { _tag: 'BlingFailed', failure: parseBlingFailure(response.status, await response.text()) };
    }

    return { _tag: 'BlingOk', value: undefined };
  }

  // Deletar um contato no Bling ERP
  async deleteContato(id: string): Promise<unknown> {
    const url = `${this.baseUrl}/contatos/${id}`;
    const response = await this.fetchWithAuth(url, {
      method: 'DELETE',
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Erro na API Bling ao deletar contato (HTTP ${response.status}): ${errorText}`);
    }

    return { success: true };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PEDIDOS DE VENDA — Bling API v3
  // ═══════════════════════════════════════════════════════════════════════

  // Atualizar um pedido existente no Bling ERP v3
  async updatePedido(id: string, payload: unknown): Promise<unknown> {
    const url = `${this.baseUrl}/pedidos/vendas/${id}`;

    const response = await this.fetchWithAuth(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Erro na API Bling ao atualizar pedido (HTTP ${response.status}):`, errorText);
      throw new Error(`Bling ERP retornou erro: ${errorText}`);
    }

    const data = await response.json();
    return data.data;
  }
  // `createPedido(payload: unknown)` foi removido no Ticket 30: era o caminho
  // não tipado que deixou o payload divergir do schema oficial em quatro
  // campos obrigatórios. Use `criarPedidoVenda`, que só aceita um
  // `PedidoVendaPayload` já validado.


  // ── Pedido de venda com contrato oficial e falha tipada ────────────────
  // As três operações abaixo substituem, na jornada de venda manual, o par
  // `createPedido` + `lancarBaixaEstoqueProduto`. Elas devolvem
  // `BlingCallResult` em vez de lançar string concatenada, porque o corpo de
  // erro da v3 é estruturado (`error.type`, `error.description`,
  // `error.fields[]`) e a UI precisa dele legível.

  /**
   * Cria o pedido de venda com o payload já validado contra o OpenAPI oficial.
   * A resposta `201` traz apenas `data.id` — não existe `data.numero` na
   * criação, ao contrário do que o código anterior supunha.
   */
  async criarPedidoVenda(payload: PedidoVendaPayload): Promise<BlingCallResult<{ id: string; alertas: readonly string[] }>> {
    const response = await this.fetchWithAuth(`${this.baseUrl}/pedidos/vendas`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      return { _tag: 'BlingFailed', failure: parseBlingFailure(response.status, await response.text()) };
    }

    const parsed = pedidoVendaCreatedSchema.safeParse(await response.json());
    if (!parsed.success) {
      return blingFailure('INVALID_RESPONSE', response.status, 'O Bling respondeu sucesso sem informar o ID do pedido criado.');
    }

    return {
      _tag: 'BlingOk',
      value: { id: parsed.data.data.id, alertas: (parsed.data.data.alertas ?? []).map((alerta) => alerta.msg) },
    };
  }

  /**
   * Lança o estoque do pedido no depósito padrão.
   *
   * Substitui o `POST /estoques` com `operacao: 'S'` que a venda manual usava:
   * aquele endpoint cria um **ajuste manual desvinculado do pedido**, que se
   * soma à baixa que o próprio Bling faz quando a situação do pedido a
   * dispara. Este é o endpoint que o Bling documenta para a operação.
   */
  /**
   * Marca um pedido de venda como cancelado, com falha tipada.
   *
   * Serve de compensação: quando o Bling aceita a venda e o ORBITA não
   * consegue gravá-la, é isto que impede o pedido de ficar órfão na conta do
   * lojista. Cancelar em vez de apagar preserva o rastro de que a venda chegou
   * a existir no ERP, e a sincronização traz o pedido cancelado para cá — os
   * dois lados convergem.
   *
   * O id da situação é por conta, então precisa ser descoberto: o schema
   * oficial de `/situacoes/modulos` expõe só `{ id, nome }`, sem o código
   * numérico, então casar pelo nome é o único caminho que a API oferece.
   */
  async cancelarPedidoVenda(idPedido: string): Promise<BlingCallResult<void>> {
    // **Um** orçamento para a compensação inteira — descoberta e mutação.
    //
    // Antes o prazo cobria só a descoberta e terminava antes do `PATCH`, que é
    // justamente o passo que cancela o pedido. Uma espera ou uma exceção ali
    // deixava a venda manual sem devolver a instrução de cancelar à mão, que é
    // o que impede a próxima tentativa de criar um segundo pedido órfão. O teto
    // estava em toda parte menos onde importava.
    return this.comOrcamento('bling.pedido.cancelar', 'cancelar o pedido', (prazo) =>
      this.cancelarPedidoVendaComPrazo(idPedido, prazo),
    );
  }

  private async cancelarPedidoVendaComPrazo(
    idPedido: string,
    prazo: AbortSignal,
  ): Promise<BlingCallResult<void>> {
    const situacoesResult = await this.descobrirSituacoesDePedidoDeVenda(prazo);
    if (situacoesResult._tag === 'BlingFailed') return situacoesResult;

    const cancelado = encontrarSituacaoDeCancelamento(situacoesResult.value);
    if (!cancelado) {
      // Só **aqui** a conta pode ser mencionada, porque só aqui a leitura deu
      // certo: os módulos vieram, o módulo de vendas foi identificado, as
      // situações foram lidas, e nenhuma se chama "Cancelado". A mensagem lista
      // o que existe para que a pessoa confira sem adivinhar.
      const nomes = situacoesResult.value.map((situacao) => situacao.nome).join(', ');
      return blingFailure(
        'RESOURCE_NOT_FOUND',
        200,
        'Nenhuma situação de pedido de venda chamada "Cancelado" foi encontrada na conta do Bling. '
          + `As situações cadastradas são: ${nomes || 'nenhuma'}.`,
      );
    }

    // Entre a descoberta e a mutação houve leitura de corpo e busca em lista.
    // Se o prazo estourou nesse meio, o `PATCH` não chega a sair: mandar uma
    // mutação já fora do orçamento é o pior caso, porque o efeito aconteceria
    // sem ninguém esperando a resposta.
    prazo.throwIfAborted();

    const url = `${this.baseUrl}/pedidos/vendas/${encodeURIComponent(idPedido)}/situacoes/${encodeURIComponent(String(cancelado.id))}`;
    const response = await this.fetchWithAuth(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      signal: prazo,
    });

    if (!response.ok) {
      // Também redigido: esta mensagem sai na resposta pública da venda manual,
      // dentro do "o cancelamento automático também falhou (…)". O que a pessoa
      // precisa dali é a instrução de cancelar à mão, e ela não depende do
      // texto do provedor.
      return this.falhaPublicaDoBling(
        'bling.pedido.cancelar',
        'cancelar o pedido',
        response,
      );
    }

    return { _tag: 'BlingOk', value: undefined };
  }

  async lancarEstoquePedidoVenda(idPedido: string): Promise<BlingCallResult<void>> {
    const response = await this.fetchWithAuth(`${this.baseUrl}/pedidos/vendas/${encodeURIComponent(idPedido)}/lancar-estoque`, {
      method: 'POST',
    });

    if (!response.ok) {
      return { _tag: 'BlingFailed', failure: parseBlingFailure(response.status, await response.text()) };
    }

    return { _tag: 'BlingOk', value: undefined };
  }

  /**
   * Id da forma de pagamento marcada como padrão (`padrao = 1`) e ativa
   * (`situacao = 1`) na conta. Os ids são por conta, então fixá-los no código
   * — como o `1`/`2` "Exemplo simples" que o modal enviava — inventa um valor.
   */
  async obterFormaPagamentoPadraoId(): Promise<BlingCallResult<number>> {
    const url = new URL(`${this.baseUrl}/formas-pagamentos`);
    url.searchParams.set('situacao', '1');

    const response = await this.fetchWithAuth(url.toString());
    if (!response.ok) {
      return { _tag: 'BlingFailed', failure: parseBlingFailure(response.status, await response.text()) };
    }

    const body = (await response.json()) as { data?: Array<{ id?: number; padrao?: number; situacao?: number }> };
    const formas = Array.isArray(body.data) ? body.data : [];
    const ativa = formas.filter((forma) => typeof forma.id === 'number' && forma.situacao !== 0);
    // `padrao`: 0 Não, 1 Padrão, 2 Padrão devolução — só o 1 serve para venda.
    const escolhida = ativa.find((forma) => forma.padrao === 1) ?? ativa[0];

    if (!escolhida?.id) {
      return blingFailure('RESOURCE_NOT_FOUND', response.status, 'Nenhuma forma de pagamento ativa foi encontrada na conta do Bling.');
    }

    return { _tag: 'BlingOk', value: escolhida.id };
  }

  /** Cadastra o contato e devolve o id, com falha tipada em vez de exceção. */
  async criarContatoParaVenda(input: {
    nome: string;
    email: string | null;
    telefone: string | null;
    documento: string | null;
  }): Promise<BlingCallResult<{ id: number }>> {
    try {
      const criado = (await this.createContato({
        nome: input.nome,
        email: input.email ?? undefined,
        telefone: input.telefone ?? undefined,
        cnpj: input.documento ?? undefined,
      })) as { data?: { id?: number | string } };

      const id = Number(criado?.data?.id);
      if (!Number.isSafeInteger(id) || id <= 0) {
        return blingFailure('INVALID_RESPONSE', 200, 'O Bling confirmou a criação do contato mas não devolveu um ID numérico.');
      }

      return { _tag: 'BlingOk', value: { id } };
    } catch (error: unknown) {
      const message = descreverErro(error);
      return blingFailure('UNKNOWN_ERROR', 0, message);
    }
  }

  // ── Produtos com contrato oficial e falha tipada (Ticket 31) ───────────

  /**
   * Cria o produto no Bling e devolve o id real.
   *
   * Nao inventa SKU: `codigo` e opcional no OpenAPI oficial, e a versao
   * anterior preenchia `ORB-<timestamp>` quando o usuario nao informava —
   * gravando no ERP um codigo que ninguem escolheu e que o registro local nao
   * guardava, o que fazia a busca seguinte falhar e duplicar o produto.
   */
  async criarProduto(payload: ProdutoBlingEntrada): Promise<BlingCallResult<{ id: string }>> {
    const corpo = corpoProdutoBling(payload);

    const response = await this.fetchWithAuth(`${this.baseUrl}/produtos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(corpo),
    });

    if (!response.ok) {
      return { _tag: 'BlingFailed', failure: parseBlingFailure(response.status, await response.text()) };
    }

    const body = (await response.json()) as { data?: { id?: number | string } };
    const id = body?.data?.id;
    if (id === undefined || id === null || String(id).trim() === '') {
      return blingFailure('INVALID_RESPONSE', response.status, 'O Bling respondeu sucesso sem informar o ID do produto criado.');
    }

    return { _tag: 'BlingOk', value: { id: String(id) } };
  }

  /** Atualiza o produto existente, com falha tipada em vez de string concatenada. */
  async atualizarProduto(id: string, payload: ProdutoBlingEntrada): Promise<BlingCallResult<void>> {
    const corpo = corpoProdutoBling(payload);

    const response = await this.fetchWithAuth(`${this.baseUrl}/produtos/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(corpo),
    });

    if (!response.ok) {
      return { _tag: 'BlingFailed', failure: parseBlingFailure(response.status, await response.text()) };
    }

    return { _tag: 'BlingOk', value: undefined };
  }

  /**
   * Define o saldo absoluto do produto (`operacao: 'B'`, balanco).
   *
   * O saldo nao pode ir no payload do produto: em `POST /produtos` o campo
   * `estoque` e um objeto (`minimo`, `maximo`, `localizacao`) e o saldo e
   * `readOnly`. So `POST /estoques` move saldo.
   */
  async definirSaldoProduto(idProduto: string, quantidade: number): Promise<BlingCallResult<void>> {
    try {
      await this.lancamentoEstoque(idProduto, quantidade, 'B');
      return { _tag: 'BlingOk', value: undefined };
    } catch (error: unknown) {
      const mensagem = descreverErro(error);
      return blingFailure('UNKNOWN_ERROR', 0, mensagem);
    }
  }

  // Deletar um pedido no Bling ERP
  async deletePedido(id: string): Promise<unknown> {
    const url = `${this.baseUrl}/pedidos/vendas/${id}`;
    const response = await this.fetchWithAuth(url, {
      method: 'DELETE',
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Erro na API Bling ao deletar pedido (HTTP ${response.status}): ${errorText}`);
    }

    return { success: true };
  }
  // `getDefaultDepositoId` e `lancarBaixaEstoqueProduto` foram removidos no
  // Ticket 30 junto com o último chamador: davam baixa por ajuste manual
  // desvinculado do pedido. Ver `lancarEstoquePedidoVenda`.


  // Alterar situação (status) de um pedido no Bling ERP
  async updateSituacaoPedido(idPedido: string | number, idSituacao: string | number): Promise<unknown> {
    const url = `${this.baseUrl}/pedidos/vendas/${encodeURIComponent(String(idPedido))}/situacoes/${encodeURIComponent(String(idSituacao))}`;
    const response = await this.fetchWithAuth(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' }
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Erro na API Bling ao alterar situação do pedido (HTTP ${response.status}): ${errorText}`);
    }

    // A resposta pode não ter um body JSON em 204 No Content, então tratamos isso
    if (response.status === 204) {
      return { success: true };
    }

    try {
      return await response.json();
    } catch (parseError) {
      console.warn(
        `Resposta HTTP ${response.status} ao alterar situação do pedido não trouxe um corpo JSON válido:`,
        parseError,
      );
      return { success: true };
    }
  }

  /**
   * As situações do módulo de **pedidos de venda** desta conta.
   *
   * Ticket 31. A versão anterior chamava `GET /situacoes/modulos` — a lista de
   * **módulos** — e procurava um campo `situacoes` dentro de cada módulo. Esse
   * campo não existe nessa rota, então a função devolvia `[]` em **qualquer**
   * conta, e quem dependia dela concluía que a conta não tinha a situação
   * procurada. Dois recursos ficaram sem funcionar por causa disso: a
   * compensação da venda manual e o botão de cancelar pedido da listagem.
   *
   * São duas chamadas porque são dois recursos, e o id do módulo é por conta:
   *
   *   1. `GET /situacoes/modulos` → acha o módulo de pedidos de venda pelo nome;
   *   2. `GET /situacoes/modulos/{idModuloSistema}` → as situações dele.
   *
   * Cada ponto de falha tem mensagem própria. A conta do lojista só é
   * mencionada quando a leitura funcionou e o dado realmente não está lá.
   */
  async obterSituacoesDePedidoDeVenda(): Promise<BlingCallResult<readonly Situacao[]>> {
    return this.comOrcamento('bling.situacoes.descobrir', 'ler as situações de venda', (prazo) =>
      this.descobrirSituacoesDePedidoDeVenda(prazo),
    );
  }

  /**
   * Roda uma conversa com o Bling sob **um** orçamento de tempo, devolvendo
   * falha tipada em vez de exceção.
   *
   * Duas coisas que o `AbortSignal` sozinho não faz, e que são o motivo deste
   * invólucro existir:
   *
   * **1. O prazo precisa valer fora do `fetch`.** `fetchWithAuth` lê a
   * credencial no cofre (rede + banco), espera na fila do rate limit, dorme no
   * backoff de 429 e pode renovar o token — que faz *polling* de até 30 s
   * esperando um lock. Um `signal` de `fetch` não interrompe nada disso, então
   * o prazo corre por fora, contra a operação inteira. O `signal` continua indo
   * ao `fetch` porque é ele que solta o socket.
   *
   * **2. `fetchWithAuth` lança.** Em 401/403 ele tenta renovar o token, e a
   * falha da renovação vira exceção. Quem chama isto de dentro de um tratamento
   * de erro — a compensação da venda manual — rejeitaria de dentro do próprio
   * `catch`, e o usuário perderia a instrução de cancelar o pedido à mão.
   *
   * **Limite conhecido:** o que já estava em voo quando o prazo estoura termina
   * sozinho, fora do ciclo da requisição — não dá para cancelar um `await` de
   * banco. O que este teto garante é **resposta** dentro do orçamento, não
   * interrupção do trabalho. `fetchWithAuth` confere o `signal` antes de cada
   * tentativa, então nenhuma requisição **nova** começa depois do prazo.
   *
   * A mensagem do erro nunca entra na resposta: aqui dentro cai o que o cofre e
   * o Postgres lançam, e `descreverErro` de um erro do Postgres carrega
   * `details` e `hint` — valor de linha (CWE-209, a política do ticket 22,
   * critério 13).
   */
  private async comOrcamento<T>(
    operacao: string,
    oQue: string,
    trabalho: (prazo: AbortSignal) => Promise<BlingCallResult<T>>,
  ): Promise<BlingCallResult<T>> {
    // `AbortController` próprio em vez de `AbortSignal.timeout`: o timer deste
    // dá para cancelar. Com `AbortSignal.timeout` o temporizador continua vivo
    // até disparar mesmo quando a chamada terminou em 50 ms, e cada chamada
    // deixava um timer e um listener pendurados — irrelevante numa, somado numa
    // sincronização inteira, não.
    const controle = new AbortController();
    const temporizador = setTimeout(
      () => controle.abort(new Error(`prazo esgotado ao ${oQue} no Bling`)),
      BlingClient.TEMPO_LIMITE_OPERACAO_MS,
    );
    const prazo = controle.signal;

    let aoAbortar: (() => void) | undefined;

    try {
      return await Promise.race([
        trabalho(prazo),
        new Promise<never>((_, rejeitar) => {
          aoAbortar = () => rejeitar(prazo.reason);
          prazo.addEventListener('abort', aoAbortar, { once: true });
        }),
      ]);
    } catch (erro: unknown) {
      registrarFalhaInterna(operacao, erro);
      return blingFailure(
        'UNKNOWN_ERROR',
        0,
        `Não foi possível falar com o Bling para ${oQue}. `
          + 'Confira a conexão em "Conectar APIs" e tente de novo.',
      );
    } finally {
      clearTimeout(temporizador);
      if (aoAbortar) prazo.removeEventListener('abort', aoAbortar);
    }
  }

  private async descobrirSituacoesDePedidoDeVenda(
    prazo: AbortSignal,
  ): Promise<BlingCallResult<readonly Situacao[]>> {
    const respostaModulos = await this.fetchWithAuth(`${this.baseUrl}/situacoes/modulos`, { signal: prazo });
    if (!respostaModulos.ok) {
      return this.falhaPublicaDoBling(
        'bling.situacoes.ler-modulos',
        'ler as situações de venda',
        respostaModulos,
      );
    }

    const modulos = lerModulos(await this.lerCorpoJson(respostaModulos));
    if (modulos === null) {
      return blingFailure(
        'INVALID_RESPONSE',
        respostaModulos.status,
        'O Bling respondeu a lista de módulos em um formato que o ORBITA não reconhece.',
      );
    }

    const modulo = encontrarModuloDePedidosDeVenda(modulos);
    if (!modulo) {
      return blingFailure(
        'RESOURCE_NOT_FOUND',
        respostaModulos.status,
        'O ORBITA não identificou o módulo de pedidos de venda entre os módulos que o Bling devolveu.',
      );
    }

    const respostaSituacoes = await this.fetchWithAuth(
      `${this.baseUrl}/situacoes/modulos/${encodeURIComponent(String(modulo.id))}`,
      { signal: prazo },
    );
    if (!respostaSituacoes.ok) {
      return this.falhaPublicaDoBling(
        'bling.situacoes.ler-situacoes',
        'ler as situações de venda',
        respostaSituacoes,
      );
    }

    const situacoes = lerSituacoes(await this.lerCorpoJson(respostaSituacoes));
    if (situacoes === null) {
      return blingFailure(
        'INVALID_RESPONSE',
        respostaSituacoes.status,
        'O Bling respondeu as situações do módulo de vendas em um formato que o ORBITA não reconhece.',
      );
    }

    return { _tag: 'BlingOk', value: situacoes };
  }

  /**
   * Resposta HTTP recusada pelo Bling, traduzida em falha **pública** —
   * ou seja, com a razão do provedor removida.
   *
   * Serve tanto leitura quanto mutação: os dois `GET` da descoberta e o
   * `PATCH` que cancela o pedido passam por aqui. O nome anterior dizia
   * "leitura" e já era falso quando o `PATCH` entrou.
   *
   * `parseBlingFailure` monta a mensagem a partir do corpo que o provedor
   * mandou: `description`/`message` do envelope, os `fields[]` — que ecoam o
   * que foi enviado — e, quando o corpo não é o envelope da v3, os primeiros
   * 300 caracteres crus. Isso é **texto livre de terceiro** indo para uma
   * resposta pública: uma página de erro de proxy, um host interno, um valor
   * submetido de volta. Publicar isso é o mesmo risco que a política do ticket
   * 22 (critério 13) fechou do lado do Postgres, só que pela outra ponta.
   *
   * A mensagem pública é montada a partir do **status** — número, vocabulário
   * fechado —, e nunca do corpo. O `type` também não sai: é `error.type` do
   * corpo, string livre do provedor.
   *
   * **O que fica registrado, dito com precisão.** Uma versão anterior deste
   * comentário afirmava que "a falha completa vai para o log", e era falso:
   * `registrarFalhaInterna` grava a **classe** do erro e um código técnico
   * validado, não o conteúdo. O corpo do provedor, portanto, **não é guardado
   * em lugar nenhum** — some da resposta e some do log.
   *
   * Isso é escolha, não descuido: guardar texto livre de terceiro num log que
   * ninguém redige seria trocar uma superfície de vazamento por outra. O que dá
   * para correlacionar é o **status**, que entra no rótulo da operação. Se um
   * dia o diagnóstico exigir mais, o lugar de decidir é o ticket 32, junto com
   * os outros chamadores de `parseBlingFailure`.
   *
   * @param operacao rótulo da telemetria — `bling.situacoes.ler-modulos`,
   *   `bling.situacoes.ler-situacoes`, `bling.pedido.cancelar`. Identifica o
   *   **passo**, não o método público que o chamou, e recebe o status junto.
   * @param oQue trecho em infinitivo que entra na frase mostrada ao usuário
   *   ("não deu para ${oQue}"). É texto nosso, nunca do provedor.
   */
  private falhaPublicaDoBling(
    operacao: string,
    oQue: string,
    response: Response,
  ): BlingCallResult<never> {
    const { status } = response;

    // O corpo **não é lido**. Antes vinha um `await response.text()` de cada
    // chamador, só para o valor ser descartado aqui — trabalho e memória gastos
    // com um texto que não vai para lugar nenhum, e um `await` a mais que pode
    // falhar por conta própria (corpo truncado, conexão caída) e mascarar um
    // status HTTP que já estava perfeitamente conhecido.
    //
    // Cancelar o fluxo em vez de consumi-lo solta a conexão de imediato. A
    // rejeição é **observada e engolida de propósito**: se o cancelamento
    // falhar, isso não pode virar rejeição solta nem, pior, mascarar um status
    // que já é conhecido. O motivo do fracasso do cancelamento não muda nada do
    // que o chamador precisa saber.
    void response.body?.cancel().catch(() => {});

    registrarFalhaInterna(`${operacao}.http-${status}`, new Error(`HTTP ${status}`));
    return blingFailure(`HTTP_${status}`, status, mensagemPublicaDeStatusDoBling(status, oQue));
  }

  /** Corpo JSON de uma resposta `ok`, ou `undefined` quando não é JSON. */
  private async lerCorpoJson(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      return undefined;
    }
  }

  // ── Contas a pagar com contrato oficial e falha tipada (Ticket 33) ─────

  /**
   * Cria a conta a pagar. Obrigatorios no OpenAPI oficial: `contato.id`,
   * `vencimento` (`format: date`) e `valor`.
   *
   * **Nao envia `situacao`**: no schema oficial ela e `readOnly`, entao o
   * valor era descartado pelo Bling. A versao anterior mandava `2` para
   * "pago" e gravava `situacao: 'pago'` localmente — a conta ficava aberta no
   * ERP e quitada no ORBITA. Quitar exige `POST /contas/pagar/{id}/baixar`.
   */
  async criarContaPagar(payload: ContaPagarBlingEntrada): Promise<BlingCallResult<{ id: string }>> {
    const corpo: Record<string, unknown> = {
      contato: { id: payload.contatoId },
      vencimento: payload.vencimento,
      valor: payload.valor,
      historico: payload.historico,
      dataEmissao: payload.dataEmissao,
      competencia: payload.competencia,
    };
    if (payload.categoriaId) corpo.categoria = { id: payload.categoriaId };

    const response = await this.fetchWithAuth(`${this.baseUrl}/contas/pagar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(corpo),
    });

    if (!response.ok) {
      return { _tag: 'BlingFailed', failure: parseBlingFailure(response.status, await response.text()) };
    }

    const body = (await response.json()) as { data?: { id?: number | string }; id?: number | string };
    const id = body?.data?.id ?? body?.id;
    if (id === undefined || id === null || String(id).trim() === '') {
      return blingFailure('INVALID_RESPONSE', response.status, 'O Bling respondeu sucesso sem informar o ID da conta a pagar.');
    }

    return { _tag: 'BlingOk', value: { id: String(id) } };
  }

  /**
   * Quita a conta a pagar. Obrigatorios: `categoria.id`, `data`, `historico`,
   * `portador.id` e `usarDataVencimento` — `portador` e a conta financeira da
   * conta Bling, que so existe se o proprietario tiver uma cadastrada.
   */
  async baixarContaPagar(idConta: string, payload: {
    data: string;
    historico: string;
    portadorId: number;
    categoriaId: number;
  }): Promise<BlingCallResult<void>> {
    const response = await this.fetchWithAuth(`${this.baseUrl}/contas/pagar/${encodeURIComponent(idConta)}/baixar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: payload.data,
        historico: payload.historico,
        portador: { id: payload.portadorId },
        categoria: { id: payload.categoriaId },
        usarDataVencimento: false,
      }),
    });

    if (!response.ok) {
      return { _tag: 'BlingFailed', failure: parseBlingFailure(response.status, await response.text()) };
    }

    return { _tag: 'BlingOk', value: undefined };
  }

  /**
   * Conta financeira (portador) da conta Bling, necessaria para quitar.
   *
   * O endpoint e `GET /contas-contabeis` — cujo proprio titulo no OpenAPI
   * oficial e "Obtem contas financeiras". **Nao existe `/contas-financeiras`**
   * na API; chamar aquele caminho devolvia 404 e fazia parecer que a conta do
   * proprietario nao tinha portador nenhum.
   *
   * Prefere `tipo: 'caixa'` ("Portador caixa sem integracao"), que toda conta
   * Bling tem por padrao — e o que permite quitar a despesa sem o usuario
   * precisar configurar nada dentro do Bling.
   */
  async obterContaFinanceiraPadraoId(): Promise<BlingCallResult<number>> {
    const response = await this.fetchWithAuth(`${this.baseUrl}/contas-contabeis`);
    if (!response.ok) {
      return { _tag: 'BlingFailed', failure: parseBlingFailure(response.status, await response.text()) };
    }

    const body = (await response.json()) as { data?: Array<{ id?: number; tipo?: string }> };
    const contas = (Array.isArray(body.data) ? body.data : []).filter((conta) => typeof conta.id === 'number');
    const escolhida = contas.find((conta) => conta.tipo === 'caixa') ?? contas[0];

    if (!escolhida?.id) {
      return blingFailure(
        'RESOURCE_NOT_FOUND',
        response.status,
        'Nenhuma conta financeira encontrada no Bling para registrar o pagamento.',
      );
    }

    return { _tag: 'BlingOk', value: escolhida.id };
  }

  // Obter lançamentos de contas a receber com paginação e filtros
  async getContasReceber(pagina = 1, limite = 100, dataInicial?: string, dataFinal?: string): Promise<unknown[]> {
    return this.lerContasPaginadas('contas a receber', '/contas/receber', pagina, limite, dataInicial, dataFinal);
  }

  // Obter lançamentos de contas a pagar com paginação e filtros
  /**
   * Lê uma página de contas (a pagar ou a receber), conferindo o envelope.
   *
   * As duas direções são a mesma requisição com outro caminho, e a checagem de
   * envelope precisa ser idêntica nas duas — duplicá-la é como uma das metades
   * fica para trás. Devolver `[]` num erro tornava "o provedor recusou"
   * indistinguível de "não há contas": o laço da sincronização lê lista vazia
   * como fim dos dados, marca checkpoint e responde sucesso com zero itens.
   */
  private async lerContasPaginadas(
    recurso: 'contas a pagar' | 'contas a receber',
    caminho: string,
    pagina: number,
    limite: number,
    dataInicial?: string,
    dataFinal?: string,
  ): Promise<unknown[]> {
    try {
      const url = new URL(`${this.baseUrl}${caminho}`);
      url.searchParams.append('pagina', pagina.toString());
      url.searchParams.append('limite', limite.toString());
      if (dataInicial) url.searchParams.append('dataVencimentoInicial', dataInicial);
      if (dataFinal) url.searchParams.append('dataVencimentoFinal', dataFinal);

      const response = await this.fetchWithAuth(url.toString());
      if (!response.ok) {
        throw new BlingLeituraError(recurso, response.status, await response.text());
      }

      const data = await response.json();
      if (!data || typeof data !== 'object' || !Array.isArray((data as { data?: unknown }).data)) {
        throw new BlingLeituraError(recurso, response.status, 'resposta sem a lista `data` esperada');
      }
      return (data as { data: unknown[] }).data;
    } catch (error: unknown) {
      if (error instanceof BlingLeituraError) throw error;
      throw new BlingLeituraError(recurso, 0, descreverErro(error));
    }
  }

  async getContasPagar(pagina = 1, limite = 100, dataInicial?: string, dataFinal?: string): Promise<unknown[]> {
    return this.lerContasPaginadas('contas a pagar', '/contas/pagar', pagina, limite, dataInicial, dataFinal);
  }


  // ═══════════════════════════════════════════════════════════════════════
  // CATEGORIAS DE PRODUTOS
  // ═══════════════════════════════════════════════════════════════════════

  // Buscar lista de categorias da API Bling v3
  async getCategorias(pagina = 1, limite = 100): Promise<unknown[]> {
    const url = `${this.baseUrl}/categorias/produtos?pagina=${pagina}&limite=${limite}`;
    const response = await this.fetchWithAuth(url);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Erro na API Bling ao buscar categorias (HTTP ${response.status}): ${errorText}`);
    }
    const data = await response.json();
    return (data.data && Array.isArray(data.data)) ? data.data : [];
  }

}

interface BlingImagePayload {
  imagemURL?: string;
  imagem_url?: string;
  urlImagem?: string;
  imagem?: string | { url?: string };
  midia?: {
    imagens?: {
      externas?: Array<{ link?: string; url?: string }>;
      internas?: Array<{ link?: string; url?: string }>;
    };
  };
  midias?: Array<{ link?: string; url?: string }>;
}

export function extractProductImageUrl(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const d = data as BlingImagePayload;
  let url: string | undefined = undefined;

  if (typeof d.imagemURL === 'string' && d.imagemURL.trim()) url = d.imagemURL;
  else if (typeof d.imagem_url === 'string' && d.imagem_url.trim()) url = d.imagem_url;
  else if (typeof d.urlImagem === 'string' && d.urlImagem.trim()) url = d.urlImagem;
  else if (typeof d.imagem === 'string' && d.imagem.trim()) url = d.imagem;
  else if (d.imagem && typeof d.imagem === 'object' && typeof d.imagem.url === 'string' && d.imagem.url.trim()) url = d.imagem.url;
  else if (d.midia?.imagens?.externas?.[0]?.link) url = d.midia.imagens.externas[0].link;
  else if (d.midia?.imagens?.internas?.[0]?.link) url = d.midia.imagens.internas[0].link;
  else if (d.midia?.imagens?.externas?.[0]?.url) url = d.midia.imagens.externas[0].url;
  else if (d.midia?.imagens?.internas?.[0]?.url) url = d.midia.imagens.internas[0].url;
  else if (d.midias?.[0]?.url) url = d.midias[0].url;
  else if (d.midias?.[0]?.link) url = d.midias[0].link;

  if (!url) return undefined;
  url = url.trim();
  const scheme = 'https';
  if (url.startsWith('//')) return `${scheme}:${url}`;
  if (!url.startsWith('http')) return `${scheme}://${url}`;
  return url;
}

/**
 * Composition root do Bling: devolve a porta, nao a classe.
 *
 * O tipo de retorno e `BlingPort` de proposito — assim nenhum consumidor pode
 * alcancar um metodo que a porta nao declara, e trocar a implementacao nao
 * exige tocar em chamador nenhum.
 */
export const bling = {
  forVerifiedOrganization: (scope: VerifiedOrganizationScope, conexaoId?: string): BlingPort =>
    BlingClient.forVerifiedOrganization(scope, conexaoId),
  forOrganization: (organizacaoId: string, conexaoId?: string): BlingPort =>
    BlingClient.forOrganization(organizacaoId, conexaoId),
};
export const extractBlingImageUrl = extractProductImageUrl;
