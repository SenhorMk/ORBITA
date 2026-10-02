// Estruturas de dados da API v3 do Bling
export interface BlingCliente {
  id: string;
  nome: string;
  codigo?: string;
  contato?: string;
  cnpj?: string;
  numeroDocumento?: string;
  email?: string;
  telefone?: string;
  celular?: string;
}

/**
 * Item de um pedido de venda — espelho de `VendasItemDTO` do OpenAPI oficial.
 *
 * `valorunitario` NÃO existe no schema do Bling; o campo é `valor`. O nome
 * falso vinha primeiro num `??`, então o fallback salvava o valor e ninguém
 * percebia que o primeiro nome nunca casava.
 */
export interface BlingItemPedido {
  codigo?: string;
  descricao?: string;
  unidade?: string;
  quantidade: number;
  /** Valor unitário do item. Nome oficial do campo. */
  valor?: number;
  desconto?: number;
  produto?: {
    /** `integer` no schema oficial. */
    id: number;
  };
}

/**
 * Pedido de venda — espelho de `VendasDadosBaseDTO` (lista) somado a
 * `VendasDadosDTO` (detalhe) do OpenAPI oficial do Bling.
 *
 * Os tipos aqui foram declarados uma vez, de memória, e nunca conferidos
 * contra o schema: `id`, `numero`, `contato.id` e `situacao.valor` estavam
 * todos como `string` e são `integer`. O último derrubava a sincronização
 * inteira em `mapBlingStatus`, com `e.trim is not a function`.
 *
 * `itens` é OPCIONAL de propósito: `GET /pedidos/vendas` (lista) não devolve
 * itens — eles só existem em `VendasDadosDTO`, do detalhe
 * `GET /pedidos/vendas/{idPedidoVenda}`. Declará-lo obrigatório fazia o
 * TypeScript garantir um `for...of` sobre `undefined`.
 *
 * Guarda: `src/services/bling-schemas.test.ts`.
 */
export interface BlingPedido {
  /** `integer` no schema oficial. */
  id: number;
  /** `integer` no schema oficial. */
  numero: number;
  data: string;
  total: number;
  situacao: {
    id: number;
    /** `integer`: código da situação da venda, não o rótulo. */
    valor: number;
  };
  contato: {
    /** `integer` no schema oficial. */
    id: number;
    nome: string;
    numeroDocumento?: string;
    tipoPessoa?: 'F' | 'J' | 'E';
  };
  /** Só vem no detalhe do pedido, nunca na listagem. */
  itens?: BlingItemPedido[];
  transporte?: {
    fretePorConta?: number;
    frete?: number;
    contato?: { nome?: string };
    etiqueta?: {
      nome?: string;
      endereco?: string;
      numero?: string;
      complemento?: string;
      bairro?: string;
      municipio?: string;
      uf?: string;
      cep?: string;
    };
  };
  desconto?: {
    valor?: number;
  };
  observacoes?: string;
  observacoesInternas?: string;
}

export interface BlingProduto {
  id: string;
  codigo?: string;
  nome: string;
  preco: number;
  unidade?: string;
  estoque?: {
    saldoFisico?: number;
  };
  imagem_url?: string;
  urlImagem?: string;
  midia?: {
    imagens?: {
      externas?: Array<{ link: string }>;
      internas?: Array<{ link: string }>;
    };
  };
}

export interface BlingCategoria {
  id: number;
  descricao: string;
  categoriaPai?: {
    id: number;
  };
}

// Estruturas do cache local (Banco de Dados Supabase)
export interface Cliente {
  id?: string;
  organizacao_id?: string;
  user_id?: string;
  bling_id: string;
  nome: string;
  cpf_cnpj?: string;
  email?: string;
  telefone?: string;
  telefone_normalizado?: string; // soft-link Chatwoot
  // Persistidos desde a migration 54. Antes eram "campos extras não salvos no
  // Supabase": o formulário de edição abria sempre vazio e um PUT sem endereço
  // podia apagar o que estava no Bling.
  tipo?: string;
  indicador_ie?: number;
  cep?: string;
  endereco?: string;
  numero?: string;
  bairro?: string;
  cidade?: string;
  uf?: string;
  created_at?: string;
  updated_at?: string;
}

export interface Categoria {
  id?: string;
  organizacao_id?: string;
  user_id?: string;
  bling_id: string;
  descricao: string;
  categoria_pai_id?: string;
  created_at?: string;
  updated_at?: string;
}

export interface Produto {
  id?: string;
  organizacao_id?: string;
  user_id?: string;
  bling_id: string;
  codigo?: string;
  nome: string;
  preco: number;
  /**
   * No banco: a imagem espelhada do Bling, regravada pela sincronização.
   * Nas leituras para a tela (`/api/dashboard`, `/api/produtos`): a imagem
   * EFETIVA — URL assinada da foto do ORBITA quando existe, senão a do Bling.
   */
  imagem_url?: string;
  /**
   * Caminho da foto escolhida no ORBITA, no bucket privado `produto-imagens`
   * (migration 70). Nunca URL. Só as rotas de foto escrevem aqui.
   */
  imagem_storage_path?: string | null;
  /**
   * A foto do ORBITA que se sabe refletida no Bling (migration 72). Igual a
   * `imagem_storage_path` = sincronizada; diferente = pendente. Só a
   * sincronização da foto escreve aqui.
   */
  imagem_bling_sync_path?: string | null;
  unidade?: string;
  estoque: number;
  estoque_reservado?: number; // trigger controlada
  categoria_id?: string; // UUID referente a 'categorias'
  created_at?: string;
  updated_at?: string;
}

export interface Pedido {
  id?: string;
  organizacao_id?: string;
  user_id?: string;
  bling_id: string;
  numero: string;
  data: string; // ISO String
  total: number;
  status: string;
  cliente_id: string; // UUID referente a 'clientes'
  /**
   * De onde o pedido entrou no Orbita: `'Bling'` ou `'Loja Física / Manual'`.
   *
   * A coluna existe desde o schema base e a leitura de pedidos é `select('*')`,
   * então o campo já chegava — só não estava declarado. **Não é canal de
   * venda**: não há marketplace aqui.
   */
  origem?: string;
  /** Frete do pedido. Coluna do schema base, também já vinha no `select('*')`. */
  frete?: number;
  created_at?: string;
  updated_at?: string;
}

export interface ItemPedido {
  id?: string;
  organizacao_id?: string;
  user_id?: string;
  pedido_id: string; // UUID
  produto_id: string; // UUID
  quantidade: number;
  valor_unitario: number;
  created_at?: string;
  updated_at?: string;
}

export interface Nfe {
  id?: string;
  organizacao_id?: string;
  user_id?: string;
  bling_id: string;
  numero: string;
  chave: string;
  status: string;
  pedido_id: string; // UUID
  emitida_em?: string;
  created_at?: string;
  updated_at?: string;
}

// Estruturas do Chatwoot
export interface ChatwootInbox {
  id?: string;
  user_id?: string;
  organizacao_id?: string;
  conexao_id?: string;
  inbox_id: number;
  created_at?: string;
  updated_at?: string;
}

export interface ChatwootContact {
  id: number;
  user_id?: string;
  organizacao_id?: string;
  conexao_id?: string;
  name: string;
  email?: string;
  phone_number?: string;
  phone_normalizado?: string; // soft-link clientes
  avatar_url?: string;
  created_at?: string;
  updated_at?: string;
}

export interface ChatwootConversation {
  id: number;
  user_id?: string;
  organizacao_id?: string;
  conexao_id?: string;
  display_id: number;
  contact_id: number;
  status: string;
  inbox_id?: number;
  channel?: string;
  updated_at?: string;
  created_at?: string;
  // Enriquecido
  contact?: ChatwootContact;
}

export interface ChatwootMessage {
  id: number;
  user_id?: string;
  organizacao_id?: string;
  conexao_id?: string;
  conversation_id: number;
  content: string;
  message_type: 'incoming' | 'outgoing' | 'template' | 'system' | 'activity' | '0' | '1' | '2' | '3';
  sender_name?: string;
  sender_id?: number | null;
  sender_type?: 'contact' | 'user' | 'agent' | null;
  created_at?: string;
  updated_at?: string;
}

// ═══════════════════════════════════════════════════════════════════════
// FINANCEIRO — Bling API v3 e Supabase
// ═══════════════════════════════════════════════════════════════════════

export interface BlingContaPagar {
  id: number;
  dataEmissao: string;
  vencimento: string;
  valor: number;
  situacao: number; // 1 = Aberto, 2 = Pago, 3 = Cancelado
  historico?: string;
  pagamento?: {
    data?: string;
  };
  categoria?: {
    id: number;
  };
}

export interface BlingContaReceber {
  id: number;
  dataEmissao: string;
  vencimento: string;
  valor: number;
  situacao: number;
  historico?: string;
  pagamento?: {
    data?: string;
  };
  categoria?: {
    id: number;
  };
}

export interface CategoriaFinanceira {
  id?: string; // UUID local
  organizacao_id?: string;
  bling_id?: number;
  descricao: string;
  tipo: 'receita' | 'despesa';
  cor?: string;
}

export interface TituloFinanceiro {
  id?: string; // UUID local
  organizacao_id?: string;
  user_id?: string;
  bling_id?: number;
  tipo: 'receber' | 'pagar';
  /**
   * `aberto`/`pago` são estados ativos; `cancelado`/`estornado` são terminais
   * — o título fica no histórico e sai dos totais. `estornado` é o pago que
   * foi revertido junto com o pedido.
   */
  situacao: 'aberto' | 'pago' | 'cancelado' | 'estornado';
  /**
   * Código bruto da situação no Bling (1..7), gravado pela sincronização
   * (migration 68). `situacao` é a projeção local, e perde informação — 3
   * Parcial, 4 Devolvido, 6 e 7 viram `aberto`; este campo guarda o original.
   * Nulo em título interno e em título ainda não ressincronizado.
   */
  situacao_bling?: number | null;
  valor: number;
  data_vencimento: string;
  data_pagamento?: string;
  /**
   * Nome curto da movimentação, informado no lançamento de despesa
   * (migration 62). **Nulo** em tudo que veio do Bling e em tudo lançado antes
   * dela: a tela exibe a `descricao` no lugar, como fallback de apresentação.
   */
  titulo?: string | null;
  descricao: string;
  categoria_id?: string; // UUID local
  conta_financeira_id?: string; // UUID local
  fornecedor_id?: string; // UUID local
  /** O pedido que originou este título, quando houver (migration 61). */
  pedido_id?: string | null;
  /** Contato do Bling a quem a despesa foi lançada — o identificador, não o nome. */
  fornecedor_bling_id?: number | null;
  /** Retrato do nome do fornecedor no momento do lançamento. Não é chave. */
  fornecedor_nome?: string | null;
  created_at?: string;
  updated_at?: string;
}

export type ProvedorIntegracao = 'bling' | 'chatwoot' | 'stripe' | 'custom';
export type StatusConexao = 'pendente' | 'conectado' | 'erro' | 'desconectado';

export interface ConexaoIntegracao {
  id: string;
  organizacao_id: string;
  provedor: ProvedorIntegracao;
  nome: string;
  status: StatusConexao;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface CredencialIntegracao {
  id: string;
  conexao_id: string;
  organizacao_id: string;
  chave_versao: string;
  dados_cifrados: string;
  created_at: string;
  updated_at: string;
}
