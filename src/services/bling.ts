import { BlingPedido, BlingCliente, BlingProduto, BlingCategoria } from '../types';
import { supabaseServer } from '../lib/supabaseServer';
import { credentialsVault } from '../lib/integrations/credentialsVault';
import { refreshBlingToken } from './blingOAuth';
import type { VerifiedOrganizationScope } from '../lib/verifiedOrganizationScope';
import {
  blingFailure,
  parseBlingFailure,
  pedidoVendaCreatedSchema,
  type BlingCallResult,
  type PedidoVendaPayload,
} from '../lib/integrations/bling/pedidoVendaContract';

const orgClientCache = new Map<string, BlingClient>();

/** Entrada comum de criacao e atualizacao de produto no Bling v3. */
interface ProdutoBlingEntrada {
  nome: string;
  codigo?: string;
  preco: number;
  tipo: string;
  situacao: string;
  formato: string;
  unidade: string;
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

/** Entrada comum de criacao e atualizacao de contato no Bling v3. */
interface ContatoBlingEntrada {
  nome: string;
  email?: string;
  telefone?: string;
  numeroDocumento?: string;
  tipo: string;
  indicadorIe: number;
  cep?: string;
  endereco?: string;
  numero?: string;
  bairro?: string;
  cidade?: string;
  uf?: string;
}

export class BlingClient {
  private baseUrl = process.env.BLING_API_BASE_URL || 'https://api.bling.com.br/Api/v3';
  private oauthUrl = process.env.BLING_OAUTH_URL || 'https://www.bling.com.br/Api/v3/oauth/token';

  private refreshTokenPromise: Promise<string> | null = null;
  private lastRequestTime: number = 0;
  private requestQueuePromise: Promise<void> = Promise.resolve();

  private readonly organizacaoId?: string;
  private conexaoId?: string;

  private constructor(organizacaoId?: string, conexaoId?: string) {
    this.organizacaoId = organizacaoId;
    this.conexaoId = conexaoId;
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
  private async getAccessToken(): Promise<string> {
    if (!this.organizacaoId) {
      throw new Error('Organizacao verificada e obrigatoria para operacoes com o Bling.');
    }

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
      throw new Error('Bling nao conectado para esta organizacao. Conclua os passos 1 e 2 em Integracoes.');
    }

    const creds = await credentialsVault.getDecryptedCredentials(this.organizacaoId, this.conexaoId);
    if (!creds?.access_token) {
      throw new Error('Bling nao conectado para esta organizacao. Conclua os passos 1 e 2 em Integracoes.');
    }

    if (creds.token_expires_at && new Date() >= new Date(creds.token_expires_at as string)) {
      return await this.forceRefreshToken();
    }

    return creds.access_token as string;
  }

  // Fila para garantir no mínimo 2 segundos entre requisições
  private async enforceRateLimit(): Promise<void> {
    const delay = 340;
    const previousPromise = this.requestQueuePromise;

    let resolveNext: () => void;
    this.requestQueuePromise = new Promise(res => { resolveNext = res; });

    await previousPromise;

    const now = Date.now();
    const timeSinceLast = now - this.lastRequestTime;
    const timeToWait = Math.max(0, delay - timeSinceLast);

    if (timeToWait > 0) {
      await new Promise(resolve => setTimeout(resolve, timeToWait));
    }

    this.lastRequestTime = Date.now();
    resolveNext!();
  }

  // Fetch autenticado com auto-refresh em caso de 401 Unauthorized
  // Fetch autenticado com auto-refresh em caso de 401 Unauthorized e retry em caso de 429
  private async fetchWithAuth(url: string, options: RequestInit = {}): Promise<Response> {
    let token = await this.getAccessToken();
    let retries = 0;

    while (retries < 2) {
      await this.enforceRateLimit();

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
        retries++;
        const retryAfter = parseInt(response.headers.get('Retry-After') || '1', 10);
        console.warn(`⚠️ Rate Limit atingido (HTTP 429). Aguardando retry com backoff...`);
        await new Promise(resolve => setTimeout(resolve, retryAfter * 1000 * Math.pow(2, retries - 1)));
        continue;
      }

      if ((response.status === 401 || response.status === 403) && retries === 0) {
        console.warn(`⚠️ Bling v3 retornou HTTP ${response.status}. Renovando token OAuth v3 para atualizar escopos/permissões...`);
        try {
          token = await this.forceRefreshToken();
          retries++;
          continue;
        } catch (err: unknown) {
          const errMessage = err instanceof Error ? err.message : String(err);
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
      const errMessage = err instanceof Error ? err.message : String(err);
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
        const errText = await response.text();
        console.warn(`⚠️ BlingClient: API Bling retornou erro (${response.status}):`, errText);
        return [];
      }

      const data = await response.json();
      return (data.data && Array.isArray(data.data)) ? data.data : [];
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.warn('⚠️ BlingClient: Erro ao buscar pedidos reais do Bling:', errorMsg);
      return [];
    }
  }

  // Obter detalhes de um pedido específico
  async getPedido(id: string): Promise<BlingPedido | null> {
    try {
      const response = await this.fetchWithAuth(`${this.baseUrl}/pedidos/vendas/${id}`);
      if (!response.ok) return null;
      const resData = await response.json();
      return resData.data || null;
    } catch {
      return null;
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
        const errText = await response.text();
        console.warn(`⚠️ BlingClient: API Bling contatos retornou erro (${response.status}):`, errText);
        return [];
      }

      const data = await response.json();
      return (data.data && Array.isArray(data.data)) ? data.data : [];
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.warn('⚠️ BlingClient: Erro ao buscar contatos do Bling:', errorMsg);
      return [];
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
      const errorMsg = error instanceof Error ? error.message : String(error);
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
        const errText = await response.text();
        console.warn(`⚠️ BlingClient: API Bling produtos retornou erro (${response.status}):`, errText);
        return [];
      }

      const data = await response.json();
      return (data.data && Array.isArray(data.data)) ? data.data : [];
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.warn('⚠️ BlingClient: Erro ao buscar produtos do Bling:', errorMsg);
      return [];
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
        const errText = await response.text();
        console.warn(`⚠️ BlingClient: API Bling categorias retornou erro (${response.status}):`, errText);
        return [];
      }

      const data = await response.json();
      return (data.data && Array.isArray(data.data)) ? data.data : [];
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
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
      if (!response.ok) return [];
      const data = await response.json();
      return (data.data && Array.isArray(data.data)) ? data.data : [];
    } catch {
      return [];
    }
  }

  // Lançamento de estoque (Operação 'B' define saldo físico absoluto)
  async lancamentoEstoque(idProduto: string, quantidade: number, operacao: string = 'B'): Promise<unknown> {
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

  // ═══════════════════════════════════════════════════════════════════════
  // PRODUTOS — Bling API v3
  // Documentação: https://developer.bling.com.br/referencia#/Produtos
  //
  // POST /Api/v3/produtos — Campos obrigatórios:
  //   nome (string) — Nome do produto
  //   tipo (string) — "P" = Produto | "S" = Serviço
  //   situacao (string) — "A" = Ativo | "I" = Inativo
  //   unidade (string) — "UN", "PÇ", "KG", etc.
  //   preco (number) — Preço de venda
  //
  // Campos opcionais importantes:
  //   codigo (string) — SKU interno
  //   formato (string) — "S" = Simples | "V" = Com variações | "E" = Com composição
  //
  // PUT /Api/v3/produtos/{idProduto} — Mesma estrutura (atualização parcial via PATCH também disponível)
  // ═══════════════════════════════════════════════════════════════════════

  // Atualizar dados de um produto no Bling ERP v3
  async updateProduto(id: string, payload: { nome?: string; codigo?: string; preco?: number; estoque?: number; tipo?: string; situacao?: string; formato?: string; unidade?: string }): Promise<unknown> {
    const url = `${this.baseUrl}/produtos/${id}`;
    const bodyPayload: Record<string, unknown> = {};
    if (payload.nome !== undefined) bodyPayload.nome = payload.nome;
    if (payload.codigo !== undefined) bodyPayload.codigo = payload.codigo;
    if (payload.preco !== undefined) bodyPayload.preco = payload.preco;

    // Campos obrigatórios no PUT do Bling v3
    bodyPayload.tipo = payload.tipo || 'P';
    bodyPayload.situacao = payload.situacao || 'A';
    bodyPayload.formato = payload.formato || 'S';
    if (payload.unidade) bodyPayload.unidade = payload.unidade;
    if (bodyPayload.formato === 'S') bodyPayload.variacoes = [];

    const response = await this.fetchWithAuth(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyPayload),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Erro na API Bling (HTTP ${response.status}): ${errText}`);
    }

    return await response.json();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CONTATOS — Bling API v3
  // Documentação: https://developer.bling.com.br/referencia#/Contatos
  //
  // POST /Api/v3/contatos — Campos obrigatórios:
  //   nome (string) — Nome do contato
  //   tipo (string) — "F" = Pessoa Física | "J" = Pessoa Jurídica | "E" = Estrangeiro
  //   contribuinte (integer) — 1 = Contribuinte ICMS | 2 = Isento | 9 = Não contribuinte
  //
  // Campos opcionais importantes:
  //   email (string) — E-mail do contato
  //   fone (string) — Telefone do contato (NÃO é "telefone")
  //   numeroDocumento (string) — CPF ou CNPJ (sem pontuação)
  //
  // PUT /Api/v3/contatos/{idContato} — Mesma estrutura
  // ═══════════════════════════════════════════════════════════════════════

  // Atualizar dados de um contato/cliente no Bling ERP v3
  async updateContato(id: string, payload: { nome?: string; email?: string; telefone?: string; cnpj?: string; tipo?: string; contribuinte?: number; cep?: string; endereco?: string; numero?: string; bairro?: string; cidade?: string; uf?: string }): Promise<unknown> {
    const url = `${this.baseUrl}/contatos/${id}`;
    const bodyPayload: Record<string, unknown> = {};
    if (payload.nome !== undefined) bodyPayload.nome = payload.nome;
    if (payload.email !== undefined) bodyPayload.email = payload.email;
    if (payload.telefone !== undefined) bodyPayload.fone = payload.telefone;

    // Configura tipo e contribuinte explícitos se fornecidos
    if (payload.tipo) bodyPayload.tipo = payload.tipo;
    if (payload.contribuinte !== undefined) bodyPayload.contribuinte = payload.contribuinte;

    if (payload.cnpj !== undefined) {
      bodyPayload.numeroDocumento = payload.cnpj;
      // Se a UI não enviou o tipo e contribuinte explícitos, infere pelo CNPJ
      if (!payload.tipo || payload.contribuinte === undefined) {
        const cleanDoc = payload.cnpj.replace(/\D/g, '');
        if (cleanDoc.length === 14) {
          if (!payload.tipo) bodyPayload.tipo = 'J';
          if (payload.contribuinte === undefined) bodyPayload.contribuinte = 1;
        } else {
          if (!payload.tipo) bodyPayload.tipo = 'F';
          if (payload.contribuinte === undefined) bodyPayload.contribuinte = 9;
        }
      }
    } else {
      // Padrão seguro se não houver documento e não foi enviado explicitamente
      if (payload.contribuinte === undefined) bodyPayload.contribuinte = 9;
      if (!payload.tipo) bodyPayload.tipo = 'F';
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
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyPayload),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Erro na API Bling (HTTP ${response.status}): ${errText}`);
    }

    return await response.json();
  }

  // Criar um novo produto no Bling ERP v3
  async createProduto(payload: { nome: string; codigo?: string; preco?: number; estoque?: number; tipo?: string; situacao?: string; formato?: string; unidade?: string }): Promise<unknown> {
    const url = `${this.baseUrl}/produtos`;
    const bodyPayload: Record<string, unknown> = {
      nome: payload.nome,
      codigo: payload.codigo || `ORB-${Date.now()}`,
      preco: payload.preco !== undefined ? payload.preco : 0,
      tipo: payload.tipo || 'P',          // P = Produto físico
      situacao: payload.situacao || 'A',       // A = Ativo
      formato: payload.formato || 'S',        // S = Simples (sem variações)
      unidade: payload.unidade || 'UN',       // Unidade padrão — OBRIGATÓRIO para NF-e
    };

    if (bodyPayload.formato === 'S') bodyPayload.variacoes = [];

    const response = await this.fetchWithAuth(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyPayload),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Erro na API Bling ao criar produto (HTTP ${response.status}): ${errText}`);
    }

    return await response.json();
  }

  // Criar um novo contato no Bling ERP v3
  // Campos obrigatórios: nome, tipo, contribuinte
  async createContato(payload: { nome: string; email?: string; telefone?: string; cnpj?: string; tipo?: string; contribuinte?: number; cep?: string; endereco?: string; numero?: string; bairro?: string; cidade?: string; uf?: string }): Promise<unknown> {
    const url = `${this.baseUrl}/contatos`;
    const bodyPayload: Record<string, unknown> = {
      nome: payload.nome,
      situacao: 'A',
      tipo: payload.tipo || 'F',           // F = Pessoa Física (padrão)
      contribuinte: payload.contribuinte !== undefined ? payload.contribuinte : 9,     // 9 = Não contribuinte ICMS (padrão seguro)
    };

    // Campos opcionais — só adicionar se tiverem valor
    if (payload.email) bodyPayload.email = payload.email;
    if (payload.telefone) bodyPayload.fone = payload.telefone;  // Campo correto: "fone"

    if (payload.cnpj) {
      bodyPayload.numeroDocumento = payload.cnpj;
      // Se CNPJ tem 14 dígitos e UI não enviou explicitamente, inferir
      if (!payload.tipo || payload.contribuinte === undefined) {
        const cleanDoc = payload.cnpj.replace(/\D/g, '');
        if (cleanDoc.length === 14) {
          if (!payload.tipo) bodyPayload.tipo = 'J';
          if (payload.contribuinte === undefined) bodyPayload.contribuinte = 1; // Contribuinte ICMS
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

  // Buscar contatos por pesquisa (Nome, CPF/CNPJ, etc.) no Bling ERP v3
  async getContatosByPesquisa(pesquisa: string): Promise<unknown[]> {
    if (!pesquisa || !pesquisa.trim()) return [];
    const url = `${this.baseUrl}/contatos?pesquisa=${encodeURIComponent(pesquisa.trim())}`;
    const response = await this.fetchWithAuth(url);
    if (!response.ok) {
      return [];
    }
    const json = await response.json();
    return json.data && Array.isArray(json.data) ? json.data : [];
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
      const message = error instanceof Error ? error.message : String(error);
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
      const mensagem = error instanceof Error ? error.message : String(error);
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

  // Buscar lista de situações de um módulo (9 = Pedidos de Venda)
  async getSituacoesModulo(idModulo: number = 9): Promise<unknown> {
    const url = `${this.baseUrl}/situacoes/modulos`;
    const response = await this.fetchWithAuth(url);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Erro na API Bling ao buscar situações (HTTP ${response.status}): ${errorText}`);
    }

    const data = await response.json();
    // Filtra para retornar apenas as situações do módulo especificado
    if (data && data.data && Array.isArray(data.data)) {
      const modulo = (data.data as Array<{ id: number; situacoes?: unknown }>).find((m) => m.id === idModulo);
      if (modulo && modulo.situacoes) {
        return modulo.situacoes;
      }
    }

    return [];
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CONTAS A PAGAR E RECEBER — Bling API v3
  // ═══════════════════════════════════════════════════════════════════════

  async createContaPagar(payload: unknown): Promise<unknown> {
    const url = `${this.baseUrl}/contas/pagar`;
    console.log('[bling] createContaPagar payload:', JSON.stringify(payload));
    const response = await this.fetchWithAuth(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Erro na API Bling ao criar Conta a Pagar (HTTP ${response.status}): ${errorText}`);
    }

    const json = await response.json();
    console.log('[bling] createContaPagar resposta completa:', JSON.stringify(json));
    return json;
  }

  // Obter lançamentos de contas a receber com paginação e filtros
  async getContasReceber(pagina = 1, limite = 100, dataInicial?: string, dataFinal?: string): Promise<unknown[]> {
    try {
      const url = new URL(`${this.baseUrl}/contas/receber`);
      url.searchParams.append('pagina', pagina.toString());
      url.searchParams.append('limite', limite.toString());
      if (dataInicial) url.searchParams.append('dataVencimentoInicial', dataInicial);
      if (dataFinal) url.searchParams.append('dataVencimentoFinal', dataFinal);

      const response = await this.fetchWithAuth(url.toString());
      if (!response.ok) return [];
      const data = await response.json();
      return (data.data && Array.isArray(data.data)) ? data.data : [];
    } catch {
      return [];
    }
  }

  // Obter lançamentos de contas a pagar com paginação e filtros
  async getContasPagar(pagina = 1, limite = 100, dataInicial?: string, dataFinal?: string): Promise<unknown[]> {
    try {
      const url = new URL(`${this.baseUrl}/contas/pagar`);
      url.searchParams.append('pagina', pagina.toString());
      url.searchParams.append('limite', limite.toString());
      if (dataInicial) url.searchParams.append('dataVencimentoInicial', dataInicial);
      if (dataFinal) url.searchParams.append('dataVencimentoFinal', dataFinal);

      const response = await this.fetchWithAuth(url.toString());
      if (!response.ok) return [];
      const data = await response.json();
      return (data.data && Array.isArray(data.data)) ? data.data : [];
    } catch {
      return [];
    }
  }

  // Obter saldo/resumo financeiro consolidado
  async getResumoFinanceiro(): Promise<{ saldoAtual: number; totalReceber: number; totalPagar: number }> {
    try {
      const [receber, pagar] = await Promise.all([
        this.getContasReceber(1, 100),
        this.getContasPagar(1, 100)
      ]);

      const totalReceber = (receber as Array<{ valor?: number; situacao?: number }>).reduce((acc, c) => c.situacao !== 2 ? acc + (Number(c.valor) || 0) : acc, 0);
      const totalPagar = (pagar as Array<{ valor?: number; situacao?: number }>).reduce((acc, c) => c.situacao !== 2 ? acc + (Number(c.valor) || 0) : acc, 0);
      const saldoAtual = totalReceber - totalPagar;

      return { saldoAtual, totalReceber, totalPagar };
    } catch {
      return { saldoAtual: 0, totalReceber: 0, totalPagar: 0 };
    }
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

  // CONTAS FINANCEIRAS (Bancárias / Caixas) - Bling API v3
  async getContasFinanceiras(): Promise<unknown[]> {
    const url = `${this.baseUrl}/contas-financeiras`;
    const response = await this.fetchWithAuth(url);
    if (!response.ok) {
      console.warn(`Erro ao buscar contas financeiras (HTTP ${response.status}):`, await response.text());
      return [];
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

export const bling = {
  forVerifiedOrganization: (scope: VerifiedOrganizationScope, conexaoId?: string) =>
    BlingClient.forVerifiedOrganization(scope, conexaoId),
  forOrganization: (organizacaoId: string, conexaoId?: string) => BlingClient.forOrganization(organizacaoId, conexaoId),
};
export const extractBlingImageUrl = extractProductImageUrl;
