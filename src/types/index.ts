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

export interface BlingItemPedido {
  codigo?: string;
  descricao?: string;
  quantidade: number;
  valorunitario?: number;
  valor?: number;
  produto?: {
    id: string;
  };
}

export interface BlingPedido {
  id: string;
  numero: string;
  data: string;
  total: number;
  situacao: {
    id: number;
    valor: string;
  };
  contato: {
    id: string;
    nome: string;
    numeroDocumento?: string;
    telefone?: string;
    email?: string;
  };
  itens: BlingItemPedido[];
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
  // Campos extras não salvos no Supabase mas usados no CRUD UI -> Bling
  tipo?: string;
  contribuinte?: number;
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
  imagem_url?: string;
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
  situacao: 'aberto' | 'pago' | 'cancelado';
  valor: number;
  data_vencimento: string;
  data_pagamento?: string;
  descricao: string;
  categoria_id?: string; // UUID local
  conta_financeira_id?: string; // UUID local
  fornecedor_id?: string; // UUID local
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
