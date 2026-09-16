import type { BlingCategoria, BlingCliente, BlingPedido, BlingProduto } from '../types';
import type { BlingCallResult, BuscaDePedidoPorNumeroLoja, PedidoVendaPayload } from '../lib/integrations/bling/pedidoVendaContract';
import type { Situacao } from '../lib/integrations/bling/situacoesContract';

/**
 * Porta de aplicação para o Bling ERP.
 *
 * Os consumidores (rotas, serviços de sync, webhook) dependem **deste tipo**,
 * e não da classe concreta `BlingClient`. Isso permite que os testes desses
 * módulos usem um fake completo da porta em vez de mock de módulo.
 *
 * ## Dois estilos de método convivendo
 *
 * Os métodos que devolvem `BlingCallResult` foram conferidos contra o OpenAPI
 * oficial: payload validado antes do envio e falha tipada com mensagem
 * legível. Os demais sinalizam falha por exceção: as leituras de sincronização
 * (`getPedidos`, `getPedido`, `getClientes`, `getProdutos`) lançam
 * `BlingLeituraError`, e alguns métodos auxiliares, como `getContatosByNome`,
 * devolvem lista vazia.
 *
 * A distinção está no tipo de retorno de propósito: um método que devolve
 * `BlingCallResult` obriga o chamador a tratar a falha.
 */
export interface BlingPort {
  // ── Diagnóstico ────────────────────────────────────────────────────────
  /** Verifica se o token é válido e a API responde. */
  ping(): Promise<boolean>;

  // ── Pedidos de venda ───────────────────────────────────────────────────
  getPedidos(pagina?: number, limite?: number, dataInicial?: string): Promise<BlingPedido[]>;
  getPedido(id: string): Promise<BlingPedido | null>;
  updatePedido(id: string, payload: unknown): Promise<unknown>;
  deletePedido(id: string): Promise<unknown>;
  updateSituacaoPedido(idPedido: string | number, idSituacao: string | number): Promise<unknown>;
  /** Payload validado contra o schema oficial antes do envio. */
  criarPedidoVenda(payload: PedidoVendaPayload): Promise<BlingCallResult<{ id: string; alertas: readonly string[] }>>;
  /** Baixa de estoque vinculada ao pedido. */
  lancarEstoquePedidoVenda(idPedido: string): Promise<BlingCallResult<void>>;
  /**
   * Procura um pedido de venda pela referência local enviada em `numeroLoja`.
   *
   * `GET /pedidos/vendas?numerosLojas[]=<ref>`. Existe para a reconciliação de
   * uma tentativa cujo `createPedidoVenda` não devolveu resposta: sem
   * `bling_id`, a referência local é o que os dois lados compartilham.
   * `NenhumPedido` = o Bling respondeu e esta consulta não viu pedido com essa
   * referência, o que não prova que ele não foi criado.
   */
  buscarPedidoVendaPorNumeroLoja(numeroLoja: string): Promise<BlingCallResult<BuscaDePedidoPorNumeroLoja>>;
  /** Compensação: marca como cancelado um pedido que o ORBITA não conseguiu gravar. */
  cancelarPedidoVenda(idPedido: string): Promise<BlingCallResult<void>>;
  /** Forma de pagamento padrão da conta. */
  obterFormaPagamentoPadraoId(): Promise<BlingCallResult<number>>;

  // ── Produtos e estoque ─────────────────────────────────────────────────
  getProdutos(pagina?: number, limite?: number, codigo?: string, dataAlteracaoInicial?: string): Promise<BlingProduto[]>;
  getProduto(id: string): Promise<BlingProduto | null>;
  deleteProduto(id: string): Promise<unknown>;
  getEstoquesSaldos(idsProdutos: string[]): Promise<unknown[]>;
  getCategoriasProdutos(pagina?: number, limite?: number): Promise<BlingCategoria[]>;
  /** Busca por SKU exato, com conferência do código. */
  buscarProdutoPorCodigo(codigo: string): Promise<BlingProduto | null>;
  criarProduto(payload: ProdutoBlingEntrada): Promise<BlingCallResult<{ id: string }>>;
  atualizarProduto(id: string, payload: ProdutoBlingEntrada): Promise<BlingCallResult<void>>;
  definirSaldoProduto(idProduto: string, quantidade: number): Promise<BlingCallResult<void>>;

  // ── Contatos ───────────────────────────────────────────────────────────
  getClientes(pagina?: number, limite?: number, dataAlteracaoInicial?: string): Promise<BlingCliente[]>;
  getContatosByNome(nome: string): Promise<BlingCliente[]>;
  deleteContato(id: string): Promise<unknown>;
  /** Campos conforme o OpenAPI oficial: `telefone` e `indicadorIe`. */
  criarContato(payload: ContatoBlingEntrada): Promise<BlingCallResult<{ id: string }>>;
  atualizarContato(id: string, payload: ContatoBlingEntrada): Promise<BlingCallResult<void>>;
  /** Cadastro de contato durante a venda manual. */
  criarContatoParaVenda(input: {
    nome: string;
    email: string | null;
    telefone: string | null;
    documento: string | null;
  }): Promise<BlingCallResult<{ id: number }>>;
  /** Cadastro de contato com endereço completo, usado por fornecedores. */
  createContato(payload: ContatoLegadoEntrada): Promise<unknown>;

  // ── Financeiro ─────────────────────────────────────────────────────────
  getContasPagar(pagina?: number, limite?: number, dataInicial?: string, dataFinal?: string): Promise<unknown[]>;
  getContasReceber(pagina?: number, limite?: number, dataInicial?: string, dataFinal?: string): Promise<unknown[]>;
  getCategorias(): Promise<unknown[]>;
  /** Conferidos contra o schema oficial; quitar é uma chamada separada da criação. */
  criarContaPagar(payload: ContaPagarBlingEntrada): Promise<BlingCallResult<{ id: string }>>;
  baixarContaPagar(idConta: string, payload: BaixaContaPagarEntrada): Promise<BlingCallResult<void>>;
  /** Portador (`GET /contas-contabeis`), necessário para quitar. */
  obterContaFinanceiraPadraoId(): Promise<BlingCallResult<number>>;

  // ── Fiscal e configuração ──────────────────────────────────────────────
  createNfe(payload: unknown): Promise<unknown>;
  /**
   * Situações do módulo de pedidos de venda da conta.
   *
   * O id do módulo é por conta e é descoberto dentro da operação, então não há
   * parâmetro a passar.
   *
   * **Falha como valor:** devolve `BlingCallResult`, e o ramo `BlingFailed`
   * precisa ser tratado — `comOrcamento` converte exceções em falha tipada.
   * Tratar falha como lista vazia transformaria "não consegui ler" em "a conta
   * não tem a situação".
   *
   * **Lista vazia é resposta legítima:** significa módulo encontrado e sem
   * situações cadastradas. Formato irreconhecível vem como falha, não como `[]`.
   *
   * **Tem teto de tempo próprio** (`BlingClient.TEMPO_LIMITE_OPERACAO_MS`) para
   * a resposta, cobrindo as duas requisições e as esperas entre elas. O trabalho
   * já em voo quando o teto estoura pode terminar depois, fora da requisição.
   */
  obterSituacoesDePedidoDeVenda(): Promise<BlingCallResult<readonly Situacao[]>>;
}

/** Entrada de criação e atualização de produto. */
export interface ProdutoBlingEntrada {
  nome: string;
  codigo?: string;
  preco: number;
  tipo: string;
  situacao: string;
  formato: string;
  unidade: string;
  /** `ProdutosCategoriaDTO`: `id` é o inteiro da categoria no Bling, resolvido no servidor. */
  categoria?: { id: number };
}

/** Entrada de criação e atualização de contato. */
export interface ContatoBlingEntrada {
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

/**
 * Entrada do cadastro de contato no formato simplificado, usada pela rota de
 * fornecedores e pela venda manual. Mantida separada de `ContatoBlingEntrada`
 * porque não é validada por schema antes do envio.
 */
export interface ContatoLegadoEntrada {
  nome: string;
  email?: string;
  telefone?: string;
  cnpj?: string;
  tipo?: string;
  /**
   * Indicador de IE — `indicadorIe` no OpenAPI oficial. Um nome que o Bling não
   * tem (como `contribuinte`) seria aceito na requisição e descartado em silêncio.
   */
  indicadorIe?: number;
  cep?: string;
  endereco?: string;
  numero?: string;
  bairro?: string;
  cidade?: string;
  uf?: string;
}

/** Entrada de `POST /contas/pagar`. */
export interface ContaPagarBlingEntrada {
  contatoId: number;
  vencimento: string;
  valor: number;
  historico: string;
  dataEmissao: string;
  competencia: string;
  categoriaId?: number;
}

/** Entrada de `POST /contas/pagar/{id}/baixar`. */
export interface BaixaContaPagarEntrada {
  data: string;
  historico: string;
  portadorId: number;
  categoriaId: number;
}
