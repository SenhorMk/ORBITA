import type { BlingCategoria, BlingCliente, BlingPedido, BlingProduto } from '../types';
import type { BlingCallResult, PedidoVendaPayload } from '../lib/integrations/bling/pedidoVendaContract';

/**
 * Porta de aplicação para o Bling ERP.
 *
 * Os consumidores (rotas, serviços de sync, webhook) dependem **deste tipo**,
 * nunca da classe concreta. Isso permite que os testes de unidade desses
 * módulos usem um fake da porta em vez de mock de módulo — que era a única
 * opção enquanto o tipo era `ReturnType<typeof bling.forVerifiedOrganization>`,
 * um apelido para a implementação.
 *
 * A superfície aqui é a que tem chamador real, apurada no inventário do
 * Ticket 10b (`docs/migrations/ticket-10b-bling-callers-inventory.md`): 43
 * métodos públicos existiam em `BlingClient`, 33 com chamador de produção e 7
 * completamente mortos, removidos.
 *
 * ## Duas gerações de método convivendo
 *
 * Os métodos que devolvem `BlingCallResult` são os revisados nos Tickets 30-33
 * contra o OpenAPI oficial: payload validado antes do envio e falha tipada com
 * mensagem legível. Os que lançam exceção ou devolvem lista vazia em erro são
 * os anteriores, ainda não revisados — leitura e sincronização, onde uma falha
 * degrada para "sem dados" em vez de corromper o ERP.
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
  /** Revisado no Ticket 30 contra o schema oficial. */
  criarPedidoVenda(payload: PedidoVendaPayload): Promise<BlingCallResult<{ id: string; alertas: readonly string[] }>>;
  /** Baixa de estoque vinculada ao pedido (Ticket 30). */
  lancarEstoquePedidoVenda(idPedido: string): Promise<BlingCallResult<void>>;
  /** Forma de pagamento padrão da conta (Ticket 30). */
  obterFormaPagamentoPadraoId(): Promise<BlingCallResult<number>>;

  // ── Produtos e estoque ─────────────────────────────────────────────────
  getProdutos(pagina?: number, limite?: number, codigo?: string, dataAlteracaoInicial?: string): Promise<BlingProduto[]>;
  getProduto(id: string): Promise<BlingProduto | null>;
  deleteProduto(id: string): Promise<unknown>;
  getEstoquesSaldos(idsProdutos: string[]): Promise<unknown[]>;
  getCategoriasProdutos(pagina?: number, limite?: number): Promise<BlingCategoria[]>;
  /** Busca por SKU exato, com conferência do código (Ticket 31). */
  buscarProdutoPorCodigo(codigo: string): Promise<BlingProduto | null>;
  criarProduto(payload: ProdutoBlingEntrada): Promise<BlingCallResult<{ id: string }>>;
  atualizarProduto(id: string, payload: ProdutoBlingEntrada): Promise<BlingCallResult<void>>;
  definirSaldoProduto(idProduto: string, quantidade: number): Promise<BlingCallResult<void>>;

  // ── Contatos ───────────────────────────────────────────────────────────
  getClientes(pagina?: number, limite?: number, dataAlteracaoInicial?: string): Promise<BlingCliente[]>;
  getContatosByNome(nome: string): Promise<BlingCliente[]>;
  deleteContato(id: string): Promise<unknown>;
  /** Revisados no Ticket 32: campos `telefone` e `indicadorIe`. */
  criarContato(payload: ContatoBlingEntrada): Promise<BlingCallResult<{ id: string }>>;
  atualizarContato(id: string, payload: ContatoBlingEntrada): Promise<BlingCallResult<void>>;
  /** Cadastro de contato durante a venda manual (Ticket 30). */
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
  /** Revisados no Ticket 33 contra o schema oficial. */
  criarContaPagar(payload: ContaPagarBlingEntrada): Promise<BlingCallResult<{ id: string }>>;
  baixarContaPagar(idConta: string, payload: BaixaContaPagarEntrada): Promise<BlingCallResult<void>>;
  /** Portador (`GET /contas-contabeis`), necessário para quitar (Ticket 33). */
  obterContaFinanceiraPadraoId(): Promise<BlingCallResult<number>>;

  // ── Fiscal e configuração ──────────────────────────────────────────────
  createNfe(payload: unknown): Promise<unknown>;
  getSituacoesModulo(idModulo?: number): Promise<unknown>;
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
}

/** Entrada de criação e atualização de contato (Ticket 32). */
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
 * Entrada do cadastro de contato ainda no formato antigo, usada pela rota de
 * fornecedores. Mantida separada de `ContatoBlingEntrada` para não dar a
 * entender que já passou pela revisão contra o schema oficial.
 */
export interface ContatoLegadoEntrada {
  nome: string;
  email?: string;
  telefone?: string;
  cnpj?: string;
  tipo?: string;
  contribuinte?: number;
  cep?: string;
  endereco?: string;
  numero?: string;
  bairro?: string;
  cidade?: string;
  uf?: string;
}

/** Entrada de `POST /contas/pagar` (Ticket 33). */
export interface ContaPagarBlingEntrada {
  contatoId: number;
  vencimento: string;
  valor: number;
  historico: string;
  dataEmissao: string;
  competencia: string;
  categoriaId?: number;
}

/** Entrada de `POST /contas/pagar/{id}/baixar` (Ticket 33). */
export interface BaixaContaPagarEntrada {
  data: string;
  historico: string;
  portadorId: number;
  categoriaId: number;
}
