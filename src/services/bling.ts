import { z } from 'zod';

import { BlingPedido, BlingCliente, BlingProduto, BlingCategoria } from '../types';
import type { VerifiedOrganizationScope } from '../lib/verifiedOrganizationScope';
import { descreverErro } from '../lib/erroLegivel';
import type {
  BlingPort,
  BorderoLido,
  ContaPagarBlingEntrada,
  ContaPagarDetalhada,
  ContaPagarResumida,
  FiltroDeContasPagar,
  ListagemDeContasPagar,
  ContaPagarRemota,
  ContatoBlingEntrada,
  ContatoLegadoEntrada,
  ProdutoBlingEntrada,
} from './blingPort';
import { dadosFiscaisDoContatoSchema, type ContatoTipo, type IndicadorIe } from '../lib/config/clienteContract';
import {
  blingFailure,
  parseBlingFailure,
  type BuscaDePedidoPorNumeroLoja,
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
import type {
  CausaIndeterminada,
  ContatoRemoto,
  EscritaRemota,
  ExclusaoRemota,
  FalhaDeOperacaoRemota,
  LeituraRemota,
  ProdutoRemoto,
} from '../lib/integrations/bling/operacaoRemotaContract';
import { codigoDaSituacaoDaContaSchema } from '../lib/integrations/bling/situacaoDaContaBling';
import { registrarFalhaInterna } from '../lib/observability/falhaInterna';
import { FilaDeRequisicoes, esperar, type Dormir } from './filaDeRequisicoes';
import type { TokenDoBling } from './blingToken';
import type { EnvioDeCriacaoAoBling } from '../lib/integrations/bling/classificacaoDeFalhaDeCriacao';
import { tokenDoBlingReal } from './blingCredenciaisSupabase';

/**
 * Adapter HTTP da API REST v3 do Bling. A troca OAuth (código ou refresh token
 * por access token) fica à parte, em `blingOAuth.ts`.
 *
 * ONDE ESTAMOS: na última camada antes do fornecedor. As regras (autorização,
 * tentativa, estoque, financeiro, reconciliação) já foram decididas antes; quem
 * chama é o ORBITA pelo `BlingPort` (`blingPort.ts`) ou por ports específicos,
 * como o da venda manual (`pedidos/manual/portsDoBling.ts`). EFEITO EXTERNO:
 * daqui sai a requisição para a API do Bling.
 *
 * Responsabilidades:
 * - **escopo**: um `BlingClient` pertence a uma organização; a credencial é
 *   descoberta no cofre dessa organização (`TokenDoBling`), nunca por usuário;
 * - **transporte**: `fetchWithAuth` injeta o bearer, espaça as requisições
 *   (`FilaDeRequisicoes`), faz backoff em 429 e renova o token uma vez em 401/403;
 * - **contrato**: as operações de escrita tipadas conferem a resposta (por
 *   schema Zod ou checagem explícita do id) e devolvem falha tipada
 *   (`BlingCallResult`); leituras de sincronização lançam `BlingLeituraError`
 *   em vez de devolver lista vazia;
 * - **privacidade**: mensagens públicas derivam do status HTTP, não do corpo
 *   devolvido pelo provedor.
 *
 * Limite importante: uma chamada ao Bling não participa de nenhuma transação do
 * banco do ORBITA. Se a resposta se perde, o Bling pode ter aplicado a escrita
 * sem que o ORBITA saiba. Quem cria pedidos trata esse caso como resultado
 * ambíguo (ver `app/api/pedidos/manual`).
 */

/**
 * As peças externas que o cliente usa além do HTTP com o Bling.
 *
 * **Completas, sempre.** Aceitar peças parciais e completar o resto com a
 * infraestrutura real permitiria um teste rodar meio dublado e meio contra
 * Supabase e cofre de verdade, sem nada avisando.
 *
 * A construção normal usa exatamente esta composição, montada em
 * `portasReais`. A porta não existe para o teste; ela existe porque este é o
 * limite entre falar com o Bling e descobrir com que credencial falar.
 */
export interface PortasDoClienteBling {
  /** Espera cancelável, usada na fila e no backoff de 429. */
  readonly dormir: Dormir;
  /** Obtenção e renovação do token, como uma capacidade só. */
  readonly token: TokenDoBling;
}

/** A composição de produção, e a mesma que os testes trocam por inteiro. */
export function portasReais(organizacaoId: string, conexaoId?: string): PortasDoClienteBling {
  return { dormir: esperar, token: tokenDoBlingReal(organizacaoId, conexaoId) };
}

const orgClientCache = new Map<string, BlingClient>();



/**
 * Frase pública para uma falha HTTP do Bling, derivada **só do status**.
 *
 * Vocabulário fechado, escrito aqui: nada do corpo da resposta do provedor
 * chega ao usuário — e **nada dele vai para o log tampouco**. O corpo sequer é
 * lido: `falhaPublicaDoBling` cancela o fluxo da resposta, e
 * `registrarFalhaInterna` grava a classe do erro, não o conteúdo.
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
  if (payload.categoria) corpo.categoria = { id: payload.categoria.id };
  if (payload.formato === 'S') corpo.variacoes = [];
  return corpo;
}

/**
 * O limite de requisições do Bling persistiu depois do retry de `fetchWithAuth`.
 *
 * A documentação do Bling diz que requisição acima do limite **não é
 * processada**: quem recebe este erro sabe que nada mudou do outro lado. É
 * isso que a classe própria permite distinguir de uma falha de rede, em que o
 * efeito pode ter acontecido.
 */
export class BlingLimiteDeRequisicoesError extends Error {
  constructor() {
    super('Número máximo de retries excedido (HTTP 429 Too Many Requests).');
    this.name = 'BlingLimiteDeRequisicoesError';
  }
}

/**
 * O Bling recusou o acesso (401/403) e a renovação do token não resolveu.
 *
 * Também é recusa **antes** do efeito: a requisição não foi autorizada.
 */
export class BlingAcessoRecusadoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlingAcessoRecusadoError';
  }
}

const contatoLidoSchema = z.object({
  data: z.object({
    id: z.union([z.number().int().positive(), z.string().regex(/^\d+$/u)]),
    situacao: z.string().nullish(),
  }),
});

/**
 * `GET /produtos/{id}` reduzido ao que a exclusão confirmada e a foto precisam.
 * As imagens vêm em `midia.imagens.internas` (cópias no armazenamento do
 * Bling) e `externas`; a ausência de `midia` é produto sem imagem.
 */
const produtoLidoSchema = z.object({
  data: z.object({
    id: z.union([z.number().int().positive(), z.string().regex(/^\d+$/u)]),
    situacao: z.enum(['A', 'I', 'E']).optional(),
    midia: z.object({
      imagens: z.object({
        internas: z.array(z.unknown()).optional(),
        externas: z.array(z.unknown()).optional(),
      }).partial().optional(),
    }).partial().optional(),
  }),
});

/**
 * Resposta `201` de `POST /contas/pagar`. O OpenAPI oficial declara `{ id }`;
 * a implementação anterior lia também `{ data: { id } }`, o envelope das
 * demais respostas da v3. As duas formas são aceitas — e qualquer outra é
 * resposta inválida, nunca sucesso.
 */
const idDeContaPagarSchema = z.union([z.number().int().positive(), z.string().regex(/^\d+$/u)]);
const contaPagarCriadaSchema = z.union([
  z.object({ data: z.object({ id: idDeContaPagarSchema }) }),
  z.object({ id: idDeContaPagarSchema }),
]);

/** Resposta `200` de `POST /contas/pagar/{id}/baixar`: `{ bordero: { id } }`, com ou sem `data`. */
const borderoSchema = z.object({ id: idDeContaPagarSchema });
const baixaCriadaSchema = z.union([
  z.object({ data: z.object({ bordero: borderoSchema }) }),
  z.object({ bordero: borderoSchema }),
]);

const dataDoBlingSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);

/** Item de `GET /contas/pagar` (`ContasDadosBaseDTO`): só o que a listagem traz. */
const contaPagarResumidaSchema = z.object({
  id: idDeContaPagarSchema,
  situacao: codigoDaSituacaoDaContaSchema,
  valor: z.number(),
  vencimento: dataDoBlingSchema,
  contato: z.object({ id: z.number().int().positive() }),
});
const contasPagarListadasSchema = z.object({ data: z.array(contaPagarResumidaSchema) });

/** `GET /contas/pagar/{id}`, com os campos que a reconciliação compara. */
const contaPagarDetalhadaSchema = z.object({
  data: contaPagarResumidaSchema.extend({
    dataEmissao: dataDoBlingSchema.optional(),
    numeroDocumento: z.string().optional(),
    saldo: z.number().optional(),
    historico: z.string().optional(),
    categoria: z.object({ id: z.number().int().positive() }).optional(),
    borderos: z.array(z.number().int().positive()).optional(),
  }),
});

/** `GET /borderos/{id}`: o que prova de quem é a baixa — data e histórico. */
const borderoLidoSchema = z.object({
  data: z.object({
    id: idDeContaPagarSchema,
    data: dataDoBlingSchema,
    historico: z.string().optional(),
  }),
});

/** Linhas por página na listagem de reconciliação (o máximo que o Bling aceita). */
const LIMITE_DA_PAGINA_DE_RECONCILIACAO = 100;

const contaPagarLidaSchema = z.object({
  data: z.object({
    id: z.union([z.number().int().positive(), z.string().regex(/^\d+$/u)]),
    situacao: codigoDaSituacaoDaContaSchema,
  }),
});

/**
 * Classifica o status HTTP de uma leitura ou exclusão pelo que ele prova.
 *
 * `404` fica de fora: ele significa "ausente", e quem decide o que isso quer
 * dizer é a operação. `408` e `5xx` não provam nada sobre o efeito; os demais
 * `4xx` são recusa de validação ou de acesso — antes do efeito.
 */
function falhaPorStatus(status: number): FalhaDeOperacaoRemota {
  if (status === 429) return { _tag: 'RemotoLimitado' };
  if (status === 408) return { _tag: 'RemotoIndeterminado', causa: 'prazo_esgotado' };
  if (status >= 500) return { _tag: 'RemotoIndeterminado', causa: 'erro_do_servidor' };
  if (status >= 400) return { _tag: 'RemotoRecusou', status };
  // Um 1xx/3xx aqui não é resposta que o contrato descreva.
  return { _tag: 'RemotoIndeterminado', causa: 'resposta_invalida' };
}

/**
 * Erro de leitura do Bling.
 *
 * Distingue "o provedor recusou" (401, 403, 500, timeout) de "não há nada".
 * Numa sincronização a diferença é decisiva: se uma falha virasse `[]`, a etapa
 * "concluiria" com zero itens, o checkpoint avançaria, e as execuções seguintes
 * filtrariam por `dataAlteracaoInicial` a partir do momento da falha — os itens
 * daquele intervalo nunca seriam lidos.
 *
 * Quem realmente quiser degradar para lista vazia precisa dizer isso no ponto
 * da chamada.
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
   * pedido.
   *
   * Generoso de propósito: `enforceRateLimit` espaça as requisições em 340 ms,
   * o backoff de 429 pode somar segundos, e um teto apertado transformaria
   * lentidão em falha justamente no caminho da compensação, que é o que não
   * pode falhar por pressa.
   */
  static readonly TEMPO_LIMITE_OPERACAO_MS = 20_000;

  /**
   * Teto de **uma** requisição de correção: a leitura ou a exclusão de um
   * contato ou de uma conta a pagar. A correção faz no máximo duas em série
   * (exclusão e a leitura que a confirma), então o pior caso fica dentro do que
   * uma requisição HTTP do navegador espera sem desistir.
   */
  static readonly TEMPO_LIMITE_CORRECAO_MS = 12_000;
  /** Teto de páginas da listagem de reconciliação; atingido, a listagem é incompleta. */
  static readonly PAGINAS_MAXIMAS_DE_RECONCILIACAO = 5;

  private baseUrl = process.env.BLING_API_BASE_URL || 'https://api.bling.com.br/Api/v3';

  private readonly fila: FilaDeRequisicoes;
  private readonly portas: PortasDoClienteBling;

  /**
   * @param organizacaoId organização já verificada. **Obrigatória**: sem ela não
   *   há credencial para descobrir, e deixar passar produziria consulta com
   *   escopo vazio em vez de falha.
   * @param conexaoId conexão já conhecida, quando o chamador a tem.
   * @param portas composição alternativa — ver `comPortas`.
   */
  private constructor(organizacaoId: string, conexaoId?: string, portas?: PortasDoClienteBling) {
    // Sem este guarda, `organizacaoId` ausente viraria `''` e o usuário
    // receberia "Bling não conectado" para um defeito de escopo no chamador.
    if (!organizacaoId) {
      throw new Error('Organizacao verificada e obrigatoria para operacoes com o Bling.');
    }

    this.portas = portas ?? portasReais(organizacaoId, conexaoId);
    this.fila = new FilaDeRequisicoes({ dormir: this.portas.dormir });
  }

  /**
   * Cliente com portas trocadas, **sem cache**.
   *
   * O cache existe para reaproveitar token entre chamadas da mesma organização;
   * um cliente com portas próprias não é o mesmo cliente, e guardá-lo lá
   * contaminaria quem pedisse o normal depois.
   */
  static comPortas(organizacaoId: string, portas: PortasDoClienteBling): BlingClient {
    return new BlingClient(organizacaoId, undefined, portas);
  }

  /**
   * Cliente Bling da organização já provada contra a associação persistida.
   *
   * É a entrada das rotas: exigir `VerifiedOrganizationScope` no tipo impede que
   * elas chamem o Bling sem uma organização autorizada. Clientes são
   * reaproveitados por organização + conexão, junto com a fila de requisições.
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

  /**
   * Renova o token OAuth da conexão Bling da organização, mesmo ainda válido.
   *
   * A credencial vem sempre do cofre da organização. A coordenação entre
   * processos concorrentes fica em `TokenDoBlingOrquestrado.renovar`.
   */
  async forceRefreshToken(): Promise<string> {
    const resultado = await this.portas.token.renovar();
    if (resultado._tag === 'TokenObtido') return resultado.token;

    registrarFalhaInterna(`bling.token.${resultado.falha.motivo}`, resultado.falha.causa);
    throw new Error(resultado.falha.mensagem);
  }

  /**
   * Access token válido da conexão Bling **da organização**, traduzindo a falha
   * tipada em exceção.
   *
   * Existe uma única fonte de credencial — o cofre por organização. A tradução
   * acontece **aqui** de propósito: `fetchWithAuth` e seus chamadores sinalizam
   * por exceção, enquanto `TokenDoBling` devolve valor; converter na borda deixa
   * o ponto de conversão visível num lugar só.
   *
   * A `causa` da falha vai para o log, não para a mensagem: ela guarda a
   * rejeição original da porta, que pode carregar diagnóstico interno.
   */
  private async getAccessToken(signal?: AbortSignal): Promise<string> {
    const resultado = await this.portas.token.obter(signal);
    if (resultado._tag === 'TokenObtido') return resultado.token;

    registrarFalhaInterna(`bling.token.${resultado.falha.motivo}`, resultado.falha.causa);
    throw new Error(resultado.falha.mensagem);
  }

  /** Espaça as requisições ao Bling. Ver `FilaDeRequisicoes`. */
  private async enforceRateLimit(signal?: AbortSignal): Promise<void> {
    await this.fila.aguardarVez(signal);
  }

  /**
   * Requisição autenticada: fila → bearer → backoff exponencial em 429 →
   * uma renovação de token em 401/403. No máximo duas passagens pelo laço.
   */
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
        // A resposta é descartada, então o corpo precisa ser solto: no undici a
        // conexão só volta ao pool depois de o corpo ser lido ou cancelado, e
        // uma rajada de 429 deixaria corpos pendurados até esgotar o pool.
        void response.body?.cancel().catch(() => {});

        // Conferir **antes** de entrar no backoff: sem isto, uma chamada já
        // fora do prazo dormiria o intervalo inteiro só para descobrir na volta
        // que não deveria ter esperado.
        options.signal?.throwIfAborted();
        retries++;
        const retryAfter = parseInt(response.headers.get('Retry-After') || '1', 10);
        console.warn(`⚠️ Rate Limit atingido (HTTP 429). Aguardando retry com backoff...`);
        await this.portas.dormir(retryAfter * 1000 * Math.pow(2, retries - 1), options.signal ?? undefined);
        continue;
      }

      if ((response.status === 401 || response.status === 403) && retries === 0) {
        // Mesmo motivo do 429: a resposta é descartada e o corpo precisa ser
        // solto para a conexão voltar ao pool.
        void response.body?.cancel().catch(() => {});

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
            throw new BlingAcessoRecusadoError('BLING_INVALID_GRANT');
          }
          throw new BlingAcessoRecusadoError(
            `Conexão Bling OAuth v3 (HTTP ${response.status}): ${errMessage || 'Token expirado/sem permissão'}. Se você alterou permissões recentemente no Bling, por favor, clique em 'Conectar APIs' no topo da tela para reautorizar.`
          );
        }
      }

      return response;
    }

    throw new BlingLimiteDeRequisicoesError();
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
   * `null` significa **não existe** (404), e só isso. Qualquer outra falha —
   * rede caída, token expirado, 500 do Bling — lança `BlingLeituraError`: se
   * virasse `null`, a sincronização gravaria um "pedido sem itens".
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

  // Contatos filtrados por nome via `pesquisa` do Bling; qualquer falha devolve `[]`.
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
      // `codigos[]` é o filtro documentado por SKU no OpenAPI oficial; `codigo`
      // não existe em `GET /produtos` e seria ignorado, devolvendo o primeiro
      // produto da conta. `buscarProdutoPorCodigo` ainda confere o resultado.
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
   * A conferência existe porque um filtro ignorado pelo provedor devolve uma
   * lista qualquer. Confiar nela faria o cadastro de um produto novo disparar
   * um PUT sobrescrevendo nome, código e preço de um produto não relacionado,
   * seguido de um lançamento de saldo absoluto nele. Só um resultado com o
   * `codigo` idêntico ao pedido é devolvido.
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

  // Produto: leitura, exclusão confirmada e imagens.

  /** `GET /produtos/{id}`: o produto existe, e com quantas imagens? */
  async consultarProduto(id: string): Promise<LeituraRemota<ProdutoRemoto>> {
    const resposta = await this.requisicaoDeCorrecao('bling.produto.consultar', `/produtos/${encodeURIComponent(id)}`, 'GET');
    if (resposta._tag !== 'Resposta') return resposta;
    return this.lerRecursoConfirmado(resposta.response, produtoLidoSchema, (data) => ({
      id: String(data.id),
      imagens: (data.midia?.imagens?.internas?.length ?? 0) + (data.midia?.imagens?.externas?.length ?? 0),
      situacao: data.situacao ?? null,
    }));
  }

  /**
   * `PATCH /produtos/{id}/situacoes` com `E`. O Bling só exclui definitivamente
   * produto na situação "excluído": `DELETE` de produto ativo responde 400
   * (código 12), provado em 2026-10-02.
   */
  async marcarProdutoExcluido(id: string): Promise<EscritaRemota> {
    const resposta = await this.requisicaoDeCorrecao(
      'bling.produto.situacao-excluido',
      `/produtos/${encodeURIComponent(id)}/situacoes`,
      'PATCH',
      { situacao: 'E' },
    );
    if (resposta._tag !== 'Resposta') return resposta;
    return this.escritaConfirmada(resposta.response);
  }

  /**
   * `PATCH /produtos/{id}/situacoes` com `I`. É como o ORBITA tira um produto
   * da venda no Bling ao arquivá-lo: inativo, não excluído — o cadastro e o
   * histórico de vendas continuam no ERP.
   */
  async marcarProdutoInativo(id: string): Promise<EscritaRemota> {
    const resposta = await this.requisicaoDeCorrecao(
      'bling.produto.situacao-inativo',
      `/produtos/${encodeURIComponent(id)}/situacoes`,
      'PATCH',
      { situacao: 'I' },
    );
    if (resposta._tag !== 'Resposta') return resposta;
    return this.escritaConfirmada(resposta.response);
  }

  /** `DELETE /produtos/{id}` — `204` no OpenAPI oficial. Exige a situação `E` antes. */
  async excluirProduto(id: string): Promise<ExclusaoRemota> {
    const resposta = await this.requisicaoDeCorrecao('bling.produto.excluir', `/produtos/${encodeURIComponent(id)}`, 'DELETE');
    if (resposta._tag !== 'Resposta') return resposta;
    return this.exclusaoConfirmada(resposta.response);
  }

  /**
   * Remove TODAS as imagens do produto: `PATCH` com `midia.imagens.imagensURL: []`.
   * Provado em 2026-10-02: a lista vazia apaga tudo, de forma assíncrona. Não
   * existe remoção de uma imagem só pela API documentada.
   */
  async limparImagensDoProduto(id: string): Promise<EscritaRemota> {
    const resposta = await this.requisicaoDeCorrecao(
      'bling.produto.limpar-imagens',
      `/produtos/${encodeURIComponent(id)}`,
      'PATCH',
      { midia: { imagens: { imagensURL: [] } } },
    );
    if (resposta._tag !== 'Resposta') return resposta;
    return this.escritaConfirmada(resposta.response);
  }

  /**
   * Importa UMA imagem a partir de uma URL: `PATCH` com
   * `midia.imagens.imagensURL: [{ link }]`. Lista não vazia **acrescenta** (ao
   * fim, com deduplicação); o Bling copia o arquivo para o próprio
   * armazenamento, de forma assíncrona, e a URL pode expirar depois. A URL é
   * capacidade temporária: nunca vai para log nem para retorno.
   */
  async importarImagemDoProduto(id: string, url: string): Promise<EscritaRemota> {
    const resposta = await this.requisicaoDeCorrecao(
      'bling.produto.importar-imagem',
      `/produtos/${encodeURIComponent(id)}`,
      'PATCH',
      { midia: { imagens: { imagensURL: [{ link: url }] } } },
    );
    if (resposta._tag !== 'Resposta') return resposta;
    return this.escritaConfirmada(resposta.response);
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

  /**
   * `POST /contatos`.
   *
   * Os nomes de campo são os do OpenAPI oficial: `telefone` e `indicadorIe`.
   * Campos inexistentes no schema (como `fone` ou `contribuinte`) seriam
   * aceitos pelo Bling e descartados em silêncio.
   *
   * `tipo` e `indicadorIe` vão como vieram, e sem eles nada é enviado
   * (PRE-010). Não há padrão nem dedução pelo documento: um CNPJ não diz se a
   * empresa é contribuinte, isenta ou não contribuinte de ICMS, e um `9`
   * inventado é tão errado quanto um `1` inventado.
   */
  async createContato(payload: ContatoLegadoEntrada): Promise<unknown> {
    const fiscal = dadosFiscaisDoContatoSchema.safeParse({ tipo: payload.tipo, indicadorIe: payload.indicadorIe });
    if (!fiscal.success) {
      throw new Error('Contato sem tipo de pessoa e tipo de contribuinte escolhidos: nada foi enviado ao Bling.');
    }

    const url = `${this.baseUrl}/contatos`;
    const bodyPayload: Record<string, unknown> = {
      nome: payload.nome,
      situacao: 'A',
      tipo: fiscal.data.tipo,
      indicadorIe: fiscal.data.indicadorIe,
    };

    // Campos opcionais — só adicionar se tiverem valor
    if (payload.email) bodyPayload.email = payload.email;
    if (payload.telefone) bodyPayload.telefone = payload.telefone;
    if (payload.cnpj) bodyPayload.numeroDocumento = payload.cnpj;

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

  // ── Contatos com contrato oficial e falha tipada ───────────────────────

  /**
   * Corpo de `POST`/`PUT /contatos` conforme o OpenAPI oficial.
   *
   * Campos que **não existem** no schema são descartados em silêncio pelo
   * provedor, então os nomes seguem o contrato:
   *
   * - telefone em `telefone` (não `fone`);
   * - indicador de ICMS em `indicadorIe` (`1` contribuinte, `2` isento,
   *   `9` não contribuinte), não `contribuinte`;
   * - endereço sob `endereco.geral`.
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

  /** `GET /contatos/{id}`: o contato existe nesta conta do Bling? */
  async consultarContato(id: string): Promise<LeituraRemota<ContatoRemoto>> {
    const resposta = await this.requisicaoDeCorrecao('bling.contato.consultar', `/contatos/${encodeURIComponent(id)}`, 'GET');
    if (resposta._tag !== 'Resposta') return resposta;
    return this.lerRecursoConfirmado(resposta.response, contatoLidoSchema, (data) => ({ id: String(data.id), situacao: data.situacao ?? null }));
  }

  /** `DELETE /contatos/{id}` — `204` no OpenAPI oficial. */
  async excluirContato(id: string): Promise<ExclusaoRemota> {
    const resposta = await this.requisicaoDeCorrecao('bling.contato.excluir', `/contatos/${encodeURIComponent(id)}`, 'DELETE');
    if (resposta._tag !== 'Resposta') return resposta;
    return this.exclusaoConfirmada(resposta.response);
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
  // Criação de pedido só existe tipada: use `criarPedidoVenda`, que aceita
  // apenas um `PedidoVendaPayload` já validado.


  // ── Pedido de venda com contrato oficial e falha tipada ────────────────
  // As operações abaixo servem à jornada de venda manual. Elas devolvem
  // `BlingCallResult` em vez de lançar string concatenada, porque o corpo de
  // erro da v3 é estruturado (`error.type`, `error.description`,
  // `error.fields[]`) e a UI precisa dele legível.

  /**
   * Cria o pedido de venda com o payload já validado contra o OpenAPI oficial.
   * A resposta `201` traz apenas `data.id` — não existe `data.numero` na criação.
   *
   * Uma falha de rede aqui **não prova** que o pedido não foi criado: o Bling
   * pode ter aplicado a escrita e a resposta ter se perdido. Por isso o payload
   * leva uma referência (`numeroLoja`) decidida antes do envio, que permite
   * procurar o pedido depois (`buscarPedidoVendaPorNumeroLoja`).
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
   * Marca um pedido de venda como cancelado, com falha tipada.
   *
   * Serve de compensação: quando o Bling aceita a venda e o ORBITA não
   * consegue gravá-la, é isto que tenta evitar que o pedido fique órfão na conta
   * do lojista. Se o cancelamento falhar ou ficar sem resposta, a tentativa fica
   * `indeterminada` e segue para reconciliação. Cancelar em vez de apagar preserva o rastro de que a venda chegou
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
    // O prazo cobre também o `PATCH`, que é o passo que cancela o pedido: uma
    // espera sem teto ali impediria a venda manual de devolver a tempo a
    // instrução de cancelar à mão.
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

  /**
   * Procura pedidos pela referência estável (`numeroLoja`) que o ORBITA decidiu.
   *
   * Classifica o resultado em `NenhumPedido`, `UmPedido` ou `VariosPedidos`.
   * `NenhumPedido` descreve só o que esta consulta viu: não prova que a
   * criação anterior falhou, e quem reconcilia não pode concluir isso sozinho.
   */
  async buscarPedidoVendaPorNumeroLoja(numeroLoja: string): Promise<BlingCallResult<BuscaDePedidoPorNumeroLoja>> {
    const url = new URL(`${this.baseUrl}/pedidos/vendas`);
    // `numerosLojas[]` é o filtro oficial do `GET /pedidos/vendas` — "Conjunto
    // de números de pedidos nas lojas", conferido no OpenAPI publicado (ver
    // `docs/integrations/bling-v3-contract.md`). É ele que permite achar o
    // pedido pela referência que o ORBITA decidiu ANTES de enviar, quando a
    // resposta da criação se perdeu e o `bling_id` nunca chegou.
    url.searchParams.append('numerosLojas[]', numeroLoja);
    url.searchParams.set('limite', '100');

    const response = await this.fetchWithAuth(url.toString());
    if (!response.ok) {
      return { _tag: 'BlingFailed', failure: parseBlingFailure(response.status, await response.text()) };
    }

    const body = (await response.json()) as {
      data?: Array<{ id?: number | string; numeroLoja?: string; situacao?: { valor?: number; nome?: string } }>;
    };
    const linhas = Array.isArray(body.data) ? body.data : [];

    // O filtro do provedor NÃO é a prova: a igualdade é conferida aqui. Um
    // filtro que faça correspondência parcial, ou que o Bling passe a ignorar
    // numa versão futura, devolveria pedidos de OUTRAS vendas — e concluir uma
    // tentativa com o pedido errado é pior do que não concluir nenhuma.
    const exatas = linhas.filter((linha) => linha.numeroLoja === numeroLoja && linha.id !== undefined);

    if (exatas.length === 0) return { _tag: 'BlingOk', value: { _tag: 'NenhumPedido' } };

    // Mais de um pedido com a MESMA referência não deveria acontecer (ver a
    // unicidade do `numeroLoja` em `reconciliacao.ts`), e é justamente por
    // isso que precisa ser tratado: se acontecer, escolher um seria escolher
    // no escuro.
    if (exatas.length > 1) {
      return {
        _tag: 'BlingOk',
        value: { _tag: 'VariosPedidos', quantidade: exatas.length, ids: exatas.map((linha) => String(linha.id)) },
      };
    }

    const [exata] = exatas;
    return {
      _tag: 'BlingOk',
      value: {
        _tag: 'UmPedido',
        pedido: {
          id: String(exata.id),
          numeroLoja,
          situacao: typeof exata.situacao?.nome === 'string' ? exata.situacao.nome : null,
        },
      },
    };
  }

  /**
   * Lança o estoque do pedido no depósito padrão (`POST .../lancar-estoque`).
   *
   * É o endpoint que o Bling documenta para a operação. Um `POST /estoques` com
   * `operacao: 'S'` criaria um **ajuste manual desvinculado do pedido**, que se
   * somaria à baixa que o próprio Bling faz quando a situação do pedido a dispara.
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
   * Estorna o estoque lançado do pedido (`POST .../estornar-estoque`), o par documentado de
   * `lancar-estoque`. Mudar a situação para "Cancelado" pela API não devolve esse estoque:
   * provado no staging em 20/11/2026 (pedido 27462764185, saldo continuou baixado).
   */
  async estornarEstoquePedidoVenda(idPedido: string): Promise<BlingCallResult<void>> {
    const response = await this.fetchWithAuth(`${this.baseUrl}/pedidos/vendas/${encodeURIComponent(idPedido)}/estornar-estoque`, {
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
   * inventaria um valor.
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

  /**
   * Cadastra o contato e devolve o id, com falha tipada em vez de exceção.
   *
   * Sem tipo de pessoa e indicador de IE válidos, recusa antes do `POST`.
   */
  async criarContatoParaVenda(input: {
    nome: string;
    email: string | null;
    telefone: string | null;
    documento: string | null;
    tipo: ContatoTipo;
    indicadorIe: IndicadorIe;
  }): Promise<BlingCallResult<{ id: number }>> {
    const fiscal = dadosFiscaisDoContatoSchema.safeParse({ tipo: input.tipo, indicadorIe: input.indicadorIe });
    if (!fiscal.success) {
      return blingFailure('VALIDATION_ERROR', 0, 'O cliente não tem tipo de pessoa e tipo de contribuinte escolhidos no cadastro.');
    }

    try {
      const criado = (await this.createContato({
        nome: input.nome,
        email: input.email ?? undefined,
        telefone: input.telefone ?? undefined,
        cnpj: input.documento ?? undefined,
        tipo: fiscal.data.tipo,
        indicadorIe: fiscal.data.indicadorIe,
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

  // ── Produtos com contrato oficial e falha tipada ───────────────────────

  /**
   * Cria o produto no Bling e devolve o id real.
   *
   * Não inventa SKU: `codigo` é opcional no OpenAPI oficial. Um código gerado
   * que o registro local não guarda faria a busca seguinte falhar e duplicar
   * o produto.
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

  /**
   * Atualiza o produto existente, com falha tipada em vez de string concatenada.
   *
   * **`PATCH`, nunca `PUT`.** Provado na conta Bling em 2026-10-02 (duas vezes,
   * com controle de estabilidade): `PUT /produtos/{id}` sem `midia` APAGA todas
   * as imagens do produto, de forma assíncrona (< 6 s). O `PATCH` com o mesmo
   * corpo aplica os campos e preserva as imagens. `midia` nunca entra aqui —
   * a foto tem operação própria (`limparImagensDoProduto`/`importarImagemDoProduto`).
   * Ver `docs/operations/foto-produto-sync-bling.md`.
   */
  async atualizarProduto(id: string, payload: ProdutoBlingEntrada): Promise<BlingCallResult<void>> {
    const corpo = corpoProdutoBling(payload);

    const response = await this.fetchWithAuth(`${this.baseUrl}/produtos/${encodeURIComponent(id)}`, {
      method: 'PATCH',
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
  // A baixa de estoque de uma venda é feita por `lancarEstoquePedidoVenda`,
  // vinculada ao pedido — nunca por ajuste manual desvinculado.


  /**
   * Altera a situação do pedido (`PATCH /pedidos/vendas/{id}/situacoes/{idSituacao}`).
   *
   * Falha tipada (PRE-006C): a recusa do Bling chega com `type` e `status`,
   * para a rota distinguir recusa comprovada de desfecho desconhecido. Antes
   * a falha era uma exceção com o corpo cru na mensagem, e a rota respondia
   * "Erro interno" tanto para a recusa quanto para o timeout.
   */
  async updateSituacaoPedido(idPedido: string | number, idSituacao: string | number): Promise<BlingCallResult<void>> {
    const url = `${this.baseUrl}/pedidos/vendas/${encodeURIComponent(String(idPedido))}/situacoes/${encodeURIComponent(String(idSituacao))}`;
    const response = await this.fetchWithAuth(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' }
    });

    if (!response.ok) {
      return { _tag: 'BlingFailed', failure: parseBlingFailure(response.status, await response.text()) };
    }
    return { _tag: 'BlingOk', value: undefined };
  }

  /**
   * As situações do módulo de **pedidos de venda** desta conta.
   *
   * `GET /situacoes/modulos` devolve só a lista de **módulos**, sem as situações
   * de cada um. Por isso são duas chamadas, e o id do módulo é por conta:
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
   * `details` e `hint` — valor de linha (CWE-209).
   */
  private async comOrcamento<T>(
    operacao: string,
    oQue: string,
    trabalho: (prazo: AbortSignal) => Promise<BlingCallResult<T>>,
  ): Promise<BlingCallResult<T>> {
    // `AbortController` próprio em vez de `AbortSignal.timeout`: o timer deste
    // dá para cancelar. Com `AbortSignal.timeout` o temporizador continuaria
    // vivo até disparar mesmo quando a chamada terminou em 50 ms, e cada
    // chamada deixaria um timer e um listener pendurados.
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
   * `PATCH` que cancela o pedido passam por aqui.
   *
   * `parseBlingFailure` monta a mensagem a partir do corpo que o provedor
   * mandou: `description`/`message` do envelope, os `fields[]` — que ecoam o
   * que foi enviado — e, quando o corpo não é o envelope da v3, os primeiros
   * 300 caracteres crus. Isso é **texto livre de terceiro** indo para uma
   * resposta pública: uma página de erro de proxy, um host interno, um valor
   * submetido de volta. Publicar isso é o mesmo risco (CWE-209) que
   * `comOrcamento` evita do lado do Postgres, só que pela outra ponta.
   *
   * A mensagem pública é montada a partir do **status** — número, vocabulário
   * fechado —, e nunca do corpo. O `type` também não sai: é `error.type` do
   * corpo, string livre do provedor.
   *
   * **O que fica registrado.** `registrarFalhaInterna` grava a **classe** do
   * erro e um código técnico validado, não o conteúdo. O corpo do provedor,
   * portanto, **não é guardado em lugar nenhum** — nem na resposta, nem no log.
   *
   * Isso é escolha: guardar texto livre de terceiro num log que ninguém redige
   * seria trocar uma superfície de vazamento por outra. O que dá para
   * correlacionar é o **status**, que entra no rótulo da operação.
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

    // O corpo **não é lido**: ele seria descartado de qualquer forma, e um
    // `await` a mais poderia falhar por conta própria (corpo truncado, conexão
    // caída) e mascarar um status HTTP já conhecido.
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

  // ── Contas a pagar com contrato oficial e falha tipada ─────────────────

  /**
   * Cria a conta a pagar. Obrigatórios no OpenAPI oficial: `contato.id`,
   * `vencimento` (`format: date`) e `valor`.
   *
   * **Não envia `situacao`**: no schema oficial ela é `readOnly` e seria
   * descartada pelo Bling. Quitar exige `POST /contas/pagar/{id}/baixar`.
   *
   * O OpenAPI oficial não oferece chave de idempotência para este `POST`: uma
   * repetição cega cria uma SEGUNDA conta. Por isso o desfecho separa o que é
   * fato do que é inferência. `NaoEnviado` só quando a credencial falhou antes
   * de qualquer requisição; todo o resto é `Despachado`, com o que voltou — e
   * "nada voltou" (prazo, conexão perdida, corpo ilegível) é falha de status
   * `0`, nunca recusa.
   */
  async criarContaPagar(payload: ContaPagarBlingEntrada): Promise<EnvioDeCriacaoAoBling<{ id: string }>> {
    try {
      await this.getAccessToken();
    } catch {
      // `getAccessToken` já registrou a causa. Nenhuma requisição saiu.
      return { _tag: 'NaoEnviado', motivo: 'credencial_indisponivel' };
    }

    const resultado = await this.comOrcamento('bling.conta-pagar.criar', 'criar a conta a pagar', (prazo) =>
      this.postarContaPagar(payload, prazo),
    );
    return { _tag: 'Despachado', resultado };
  }

  private async postarContaPagar(
    payload: ContaPagarBlingEntrada,
    prazo: AbortSignal,
  ): Promise<BlingCallResult<{ id: string }>> {
    const corpo: Record<string, unknown> = {
      contato: { id: payload.contatoId },
      vencimento: payload.vencimento,
      valor: payload.valor,
      historico: payload.historico,
      dataEmissao: payload.dataEmissao,
      competencia: payload.competencia,
    };
    if (payload.categoriaId) corpo.categoria = { id: payload.categoriaId };
    // Referência opaca do ORBITA no campo de controle interno do contrato: é o
    // que permite à reconciliação reconhecer esta conta sem heurística.
    if (payload.numeroDocumento) corpo.numeroDocumento = payload.numeroDocumento;

    const response = await this.fetchWithAuth(`${this.baseUrl}/contas/pagar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(corpo),
      signal: prazo,
    });

    if (!response.ok) {
      return { _tag: 'BlingFailed', failure: parseBlingFailure(response.status, await response.text()) };
    }

    const criada = contaPagarCriadaSchema.safeParse(await response.json());
    if (!criada.success) {
      return blingFailure('INVALID_RESPONSE', response.status, 'O Bling respondeu sucesso sem informar o ID da conta a pagar.');
    }

    return { _tag: 'BlingOk', value: { id: String('data' in criada.data ? criada.data.data.id : criada.data.id) } };
  }

  /**
   * Quita a conta a pagar. Obrigatorios: `categoria.id`, `data`, `historico`,
   * `portador.id` e `usarDataVencimento` — `portador` e a conta financeira da
   * conta Bling, que so existe se o proprietario tiver uma cadastrada.
   *
   * Sob `comOrcamento`: a quitação roda depois de a conta já existir no ERP, e
   * uma exceção aqui derrubaria a requisição inteira antes de o título ser
   * gravado no ORBITA.
   */
  async baixarContaPagar(idConta: string, payload: {
    data: string;
    historico: string;
    portadorId: number;
    categoriaId: number;
  }): Promise<EnvioDeCriacaoAoBling<{ borderoId: string | null }>> {
    try {
      await this.getAccessToken();
    } catch {
      // `getAccessToken` já registrou a causa. Nenhuma requisição saiu.
      return { _tag: 'NaoEnviado', motivo: 'credencial_indisponivel' };
    }

    const resultado = await this.comOrcamento<{ borderoId: string | null }>('bling.conta-pagar.baixar', 'quitar a conta a pagar', async (prazo) => {
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
        signal: prazo,
      });

      if (!response.ok) {
        return { _tag: 'BlingFailed', failure: parseBlingFailure(response.status, await response.text()) };
      }

      // `200` com o borderô é a confirmação do contrato. Sucesso sem o corpo
      // esperado não prova nada: a reconciliação lê a conta por id.
      const baixa = baixaCriadaSchema.safeParse(await response.json());
      if (!baixa.success) {
        return blingFailure('INVALID_RESPONSE', response.status, 'O Bling respondeu sucesso sem o borderô da quitação.');
      }
      const bordero = 'data' in baixa.data ? baixa.data.data.bordero : baixa.data.bordero;
      return { _tag: 'BlingOk', value: { borderoId: String(bordero.id) } };
    });
    return { _tag: 'Despachado', resultado };
  }

  /**
   * `GET /contas/pagar/{id}` com o que a reconciliação compara: referência,
   * contato, valor, datas, saldo e borderôs. `404` é ausência provada pela
   * leitura — mas não prova que um POST anterior não criou a conta.
   */
  async lerContaPagarParaReconciliacao(id: string): Promise<LeituraRemota<ContaPagarDetalhada>> {
    const resposta = await this.requisicaoDeCorrecao(
      'bling.conta-pagar.reconciliar.ler',
      `/contas/pagar/${encodeURIComponent(id)}`,
      'GET',
    );
    if (resposta._tag !== 'Resposta') return resposta;
    return this.lerRecursoConfirmado(resposta.response, contaPagarDetalhadaSchema, (data) => ({
      id: String(data.id),
      situacao: data.situacao,
      valor: data.valor,
      vencimento: data.vencimento,
      contatoId: data.contato.id,
      dataEmissao: data.dataEmissao ?? null,
      numeroDocumento: data.numeroDocumento ?? null,
      saldo: data.saldo ?? null,
      historico: data.historico ?? null,
      categoriaId: data.categoria?.id ?? null,
      borderos: (data.borderos ?? []).map(String),
    }));
  }

  /**
   * `GET /borderos/{id}`: data e histórico do borderô. O histórico de uma baixa
   * do ORBITA carrega a referência dela; é o que distingue a quitação do ORBITA
   * de um pagamento lançado por terceiro na mesma conta.
   */
  async lerBorderoParaReconciliacao(id: string): Promise<LeituraRemota<BorderoLido>> {
    const resposta = await this.requisicaoDeCorrecao('bling.bordero.reconciliar.ler', `/borderos/${encodeURIComponent(id)}`, 'GET');
    if (resposta._tag !== 'Resposta') return resposta;
    return this.lerRecursoConfirmado(resposta.response, borderoLidoSchema, (data) => ({
      id: String(data.id),
      data: data.data,
      historico: data.historico ?? null,
    }));
  }

  /**
   * `GET /contas/pagar` com os únicos filtros que o OpenAPI declara e que
   * estreitam a busca: emissão, vencimento e contato. Lê todas as páginas até
   * uma não cheia; se o teto de páginas for atingido, a listagem é declarada
   * incompleta — e listagem incompleta não prova nada.
   */
  async listarContasPagarParaReconciliacao(filtro: FiltroDeContasPagar): Promise<ListagemDeContasPagar> {
    const contas: ContaPagarResumida[] = [];
    for (let pagina = 1; pagina <= BlingClient.PAGINAS_MAXIMAS_DE_RECONCILIACAO; pagina++) {
      const consulta = new URLSearchParams({
        pagina: String(pagina),
        limite: String(LIMITE_DA_PAGINA_DE_RECONCILIACAO),
        dataEmissaoInicial: filtro.dataEmissao,
        dataEmissaoFinal: filtro.dataEmissao,
        dataVencimentoInicial: filtro.dataVencimento,
        dataVencimentoFinal: filtro.dataVencimento,
        ...(filtro.contatoId === null ? {} : { idContato: String(filtro.contatoId) }),
      });
      const resposta = await this.requisicaoDeCorrecao('bling.conta-pagar.reconciliar.listar', `/contas/pagar?${consulta}`, 'GET');
      if (resposta._tag !== 'Resposta') return resposta;
      const { response } = resposta;
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        return falhaPorStatus(response.status);
      }
      const lida = contasPagarListadasSchema.safeParse(await this.lerCorpoJson(response));
      if (!lida.success) return { _tag: 'RemotoIndeterminado', causa: 'resposta_invalida' };
      for (const conta of lida.data.data) {
        contas.push({
          id: String(conta.id),
          situacao: conta.situacao,
          valor: conta.valor,
          vencimento: conta.vencimento,
          contatoId: conta.contato.id,
        });
      }
      if (lida.data.data.length < LIMITE_DA_PAGINA_DE_RECONCILIACAO) return { _tag: 'Listada', contas };
    }
    return { _tag: 'ListagemIncompleta' };
  }

  /** `GET /contas/pagar/{id}`: a conta existe, e em que situação (1..7)? */
  async consultarContaPagar(id: string): Promise<LeituraRemota<ContaPagarRemota>> {
    const resposta = await this.requisicaoDeCorrecao('bling.conta-pagar.consultar', `/contas/pagar/${encodeURIComponent(id)}`, 'GET');
    if (resposta._tag !== 'Resposta') return resposta;
    return this.lerRecursoConfirmado(resposta.response, contaPagarLidaSchema, (data) => ({
      id: String(data.id),
      situacao: data.situacao,
    }));
  }

  /**
   * `DELETE /contas/pagar/{id}` — "Remove uma conta a pagar", `204`.
   *
   * O Bling não tem operação de *cancelar* conta a pagar: `situacao` é
   * `readOnly` no schema, e remover é o único efeito oficial disponível.
   */
  async excluirContaPagar(id: string): Promise<ExclusaoRemota> {
    const resposta = await this.requisicaoDeCorrecao('bling.conta-pagar.excluir', `/contas/pagar/${encodeURIComponent(id)}`, 'DELETE');
    if (resposta._tag !== 'Resposta') return resposta;
    return this.exclusaoConfirmada(resposta.response);
  }

  /**
   * Uma requisição de correção (leitura ou exclusão por id), sob teto de tempo
   * próprio e com a falha **classificada pelo que ela prova**.
   *
   * O que sai daqui como exceção de `fetchWithAuth` vira valor:
   * - limite esgotado e acesso recusado são recusas antes do efeito;
   * - prazo esgotado e qualquer outra exceção (rede, cofre, socket) ficam
   *   indeterminados — para um `DELETE`, a requisição pode ter chegado.
   *
   * Nada do corpo do provedor e nada da credencial chega ao retorno; o motivo
   * técnico vai para o log do servidor por `registrarFalhaInterna`.
   */
  private async requisicaoDeCorrecao(
    operacao: string,
    caminho: string,
    metodo: 'GET' | 'DELETE' | 'PATCH',
    corpo?: Record<string, unknown>,
  ): Promise<{ readonly _tag: 'Resposta'; readonly response: Response } | FalhaDeOperacaoRemota> {
    const controle = new AbortController();
    const temporizador = setTimeout(
      () => controle.abort(new Error(`prazo esgotado em ${operacao}`)),
      BlingClient.TEMPO_LIMITE_CORRECAO_MS,
    );
    let aoAbortar: (() => void) | undefined;

    try {
      const response = await Promise.race([
        this.fetchWithAuth(`${this.baseUrl}${caminho}`, {
          method: metodo,
          signal: controle.signal,
          ...(corpo === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) }),
        }),
        new Promise<never>((_, rejeitar) => {
          aoAbortar = () => rejeitar(controle.signal.reason);
          controle.signal.addEventListener('abort', aoAbortar, { once: true });
        }),
      ]);
      return { _tag: 'Resposta', response };
    } catch (erro: unknown) {
      registrarFalhaInterna(operacao, erro);
      if (erro instanceof BlingLimiteDeRequisicoesError) return { _tag: 'RemotoLimitado' };
      if (erro instanceof BlingAcessoRecusadoError) return { _tag: 'RemotoRecusou', status: 401 };
      const causa: CausaIndeterminada = controle.signal.aborted ? 'prazo_esgotado' : 'falha_de_rede';
      return { _tag: 'RemotoIndeterminado', causa };
    } finally {
      clearTimeout(temporizador);
      if (aoAbortar) controle.signal.removeEventListener('abort', aoAbortar);
    }
  }

  /** `2xx` de um `PATCH` é aceite da escrita; o corpo é descartado sem ser lido. */
  private escritaConfirmada(response: Response): EscritaRemota {
    void response.body?.cancel().catch(() => {});
    if (response.ok) return { _tag: 'EscritaAceita' };
    if (response.status === 404) return { _tag: 'RemotoAusente' };
    return falhaPorStatus(response.status);
  }

  /** `2xx` de um `DELETE` é a confirmação; o corpo é descartado sem ser lido. */
  private exclusaoConfirmada(response: Response): ExclusaoRemota {
    void response.body?.cancel().catch(() => {});
    if (response.ok) return { _tag: 'ExclusaoAceita' };
    if (response.status === 404) return { _tag: 'RemotoAusente' };
    return falhaPorStatus(response.status);
  }

  /**
   * `200` de uma leitura só prova presença quando o corpo tem a forma do
   * contrato. Corpo ilegível não é "presente" nem "ausente": é indeterminado.
   */
  private async lerRecursoConfirmado<S extends z.ZodType<{ data: unknown }>, T>(
    response: Response,
    schema: S,
    projetar: (data: z.infer<S>['data']) => T,
  ): Promise<LeituraRemota<T>> {
    if (response.status === 404) {
      void response.body?.cancel().catch(() => {});
      return { _tag: 'RemotoAusente' };
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      return falhaPorStatus(response.status);
    }
    const lido = schema.safeParse(await this.lerCorpoJson(response));
    if (!lido.success) return { _tag: 'RemotoIndeterminado', causa: 'resposta_invalida' };
    return { _tag: 'RemotoPresente', valor: projetar(lido.data.data) };
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
