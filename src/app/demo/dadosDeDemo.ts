/**
 * DEMONSTRAÇÃO — tudo aqui é inventado. Nenhum cliente, pedido ou produto existe.
 *
 * Este arquivo e a pasta `src/app/demo` inteira são descartáveis: apagar a pasta
 * remove a demonstração sem tocar no produto.
 */

import { supabase } from '@/lib/supabaseClient';
import type { DadosDoPainel } from '@/components/painel/useLeituraDoPainel';
import type { TituloFinanceiro } from '@/components/financeiro/useLeituraFinanceira';
import type { PedidoEnriquecido } from '@/repositories/pedidoRepository';
import type { BlingPedido, Categoria, Cliente, ItemPedido, Produto } from '@/types';

const AGORA = Date.now();
const DIA = 86_400_000;
const haDias = (dias: number, hora = 10) => {
  const data = new Date(AGORA - dias * DIA);
  data.setHours(hora, (dias * 17) % 60, 0, 0);
  return data.toISOString();
};

export const CATEGORIAS: Categoria[] = [
  { id: 'cat-1', bling_id: '9001', descricao: 'Rapé' },
  { id: 'cat-2', bling_id: '9002', descricao: 'Kuripe e Tepi' },
  { id: 'cat-3', bling_id: '9003', descricao: 'Defumador' },
  { id: 'cat-4', bling_id: '9004', descricao: 'Vestuário' },
];

function produto(n: number, codigo: string, nome: string, preco: number, estoque: number, categoria: string): Produto {
  return {
    id: `prod-${n}`,
    bling_id: String(160_000_000 + n * 37),
    codigo,
    nome,
    preco,
    estoque,
    estoque_reservado: n % 4 === 0 ? 2 : 0,
    unidade: 'UN',
    situacao: 'ativo',
    categoria_id: categoria,
    created_at: haDias(120),
    updated_at: haDias(n % 9),
  };
}

export const PRODUTOS: Produto[] = [
  produto(1, 'RP-15-CRV', 'Rapé Cravo - 15ml', 40, 14, 'cat-1'),
  produto(2, 'RP-15-TSU', 'Rapé Tsunu - 15ml', 40, 22, 'cat-1'),
  produto(3, 'RP-15-ART', 'Rapé Artemísia - 15ml', 40, 9, 'cat-1'),
  produto(4, 'RP-15-SAN', 'Rapé Sansara - 15ml', 40, 31, 'cat-1'),
  produto(5, 'RP-20-CAC', 'Rapé Cacau - 20ml', 60, 18, 'cat-1'),
  produto(6, 'RP-20-MEN', 'Rapé Menta - 20ml', 60, 3, 'cat-1'),
  produto(7, 'KP-COB', 'Kuripe Cobra', 80, 6, 'cat-2'),
  produto(8, 'KP-PAS', 'Kuripe Pássaro', 100, 4, 'cat-2'),
  produto(9, 'KP-GVD', 'Kuripe Grande Verde', 100, 0, 'cat-2'),
  produto(10, 'KP-AZC', 'Kuripe - Azul Ciano', 80, 7, 'cat-2'),
  produto(11, 'TP-BAM', 'Tepi de Bambu', 120, 5, 'cat-2'),
  produto(12, 'DF-GUA', 'Defumador Líquido - Portal do Guardião', 40, 46, 'cat-3'),
  produto(13, 'DF-LUZ', 'Defumador Líquido - Portal da Luz', 40, 38, 'cat-3'),
  produto(14, 'DF-HAR', 'Defumador Líquido - Portal da Harmonia', 40, 27, 'cat-3'),
  produto(15, 'DF-PUR', 'Defumador Líquido - Portal da Purificação', 40, 52, 'cat-3'),
  produto(16, 'VS-PUL', 'Pulseira Indígena Azul/Amarelo', 50, 2, 'cat-4'),
];

function cliente(
  n: number, nome: string, doc: string, telefone: string, cidade: string, uf: string, endereco: string,
): Cliente {
  const pj = doc.length > 14;
  return {
    id: `cli-${n}`,
    bling_id: String(170_000_000 + n * 53),
    nome,
    cpf_cnpj: doc,
    tipo: pj ? 'J' : 'F',
    email: `${nome.toLowerCase().normalize('NFD').replace(/[^a-z ]/g, '').trim().replace(/ +/g, '.')}@exemplo.com`,
    telefone,
    telefone_normalizado: `+${telefone.replace(/\D/g, '')}`,
    cep: `0${1300 + n * 7}-0${10 + n}`,
    endereco,
    numero: String(100 + n * 23),
    bairro: 'Centro',
    cidade,
    uf,
    created_at: haDias(200 - n * 9),
    updated_at: haDias(n),
  };
}

export const CLIENTES: Cliente[] = [
  cliente(1, 'Mariana Souza', '123.456.789-00', '+55 11 98842-1107', 'São Paulo', 'SP', 'Rua das Acácias'),
  cliente(2, 'Casa de Ervas Aruanda', '12.345.678/0001-00', '+55 31 99731-4420', 'Belo Horizonte', 'MG', 'Av. do Contorno'),
  cliente(3, 'Lucas Andrade', '234.567.890-00', '+55 21 99610-7734', 'Rio de Janeiro', 'RJ', 'Rua do Catete'),
  cliente(4, 'Loja Raízes da Mata', '23.456.789/0001-00', '+55 41 98455-0912', 'Curitiba', 'PR', 'Rua XV de Novembro'),
  cliente(5, 'Camila Ferraz', '345.678.901-00', '+55 11 97120-3388', 'Campinas', 'SP', 'Rua Barão de Jaguara'),
  cliente(6, 'Espaço Terapêutico Jaci', '34.567.890/0001-00', '+55 62 99288-6601', 'Goiânia', 'GO', 'Av. Anhanguera'),
  cliente(7, 'Tenda Caminho do Sol', '45.678.901/0001-00', '+55 51 99876-2210', 'Porto Alegre', 'RS', 'Av. Farrapos'),
  cliente(8, 'Rafael Monteiro', '456.789.012-00', '+55 71 98123-4409', 'Salvador', 'BA', 'Av. Sete de Setembro'),
  cliente(9, 'Instituto Flor da Mata', '56.789.012/0001-00', '+55 85 99654-7781', 'Fortaleza', 'CE', 'Av. Santos Dumont'),
  cliente(10, 'Beatriz Nogueira', '567.890.123-00', '+55 48 99911-3052', 'Florianópolis', 'SC', 'Rua Bocaiúva'),
  cliente(11, 'Empório Serra Azul', '67.890.123/0001-00', '+55 27 99745-8830', 'Vitória', 'ES', 'Av. Vitória'),
  cliente(12, 'Gustavo Prado', '678.901.234-00', '+55 81 98802-1946', 'Recife', 'PE', 'Rua da Aurora'),
];

/** [dias atrás, cliente, status, itens [produto, quantidade][], origem manual?] */
type Roteiro = readonly [number, number, string, ReadonlyArray<readonly [number, number]>, boolean?];

const ROTEIRO: readonly Roteiro[] = [
  [0, 1, 'Pendente', [[1, 2], [7, 1]]],
  [0, 2, 'Pendente', [[4, 20], [5, 10]]],
  [1, 7, 'Entregue', [[12, 6], [15, 6]]],
  [1, 4, 'Pendente', [[2, 12], [13, 8]]],
  [2, 9, 'Entregue', [[11, 2], [8, 3]]],
  [2, 3, 'Entregue', [[16, 2]], true],
  [3, 6, 'Entregue', [[1, 15], [3, 15], [14, 10]]],
  [4, 5, 'Entregue', [[9, 1], [5, 1]]],
  [5, 11, 'Entregue', [[12, 12], [13, 12]]],
  [6, 8, 'Cancelado', [[10, 1]]],
  [7, 2, 'Entregue', [[7, 4], [8, 4]]],
  [8, 10, 'Entregue', [[6, 1], [15, 1]], true],
  [9, 12, 'Atendido', [[2, 1], [10, 1]]],
  [10, 7, 'Atendido', [[5, 8]]],
  [11, 9, 'Atendido', [[4, 10], [1, 10]]],
  [13, 4, 'Atendido', [[15, 15]]],
  [14, 1, 'Atendido', [[3, 1], [12, 1]]],
  [16, 6, 'Atendido', [[11, 4]]],
  [18, 11, 'Cancelado', [[9, 2]]],
  [19, 3, 'Atendido', [[8, 1], [6, 2]]],
  [21, 2, 'Atendido', [[1, 24], [2, 24]]],
  [23, 5, 'Atendido', [[14, 1]], true],
  [25, 9, 'Atendido', [[5, 10], [6, 10]]],
  [27, 7, 'Atendido', [[13, 6], [16, 4]]],
  [29, 12, 'Atendido', [[7, 1]]],
  [33, 6, 'Atendido', [[1, 30], [4, 30]]],
  [36, 2, 'Atendido', [[7, 6], [8, 4]]],
  [38, 6, 'Atendido', [[6, 25], [2, 25]]],
  [40, 9, 'Atendido', [[11, 5]]],
  [44, 4, 'Atendido', [[12, 20], [15, 20]]],
  [46, 2, 'Atendido', [[10, 5], [16, 10]]],
  [48, 7, 'Atendido', [[5, 12]]],
  [52, 11, 'Atendido', [[13, 15], [14, 15], [3, 20]]],
  [57, 1, 'Atendido', [[9, 1], [2, 2]]],
];

export const PEDIDOS: PedidoEnriquecido[] = ROTEIRO.map(([dias, clienteN, status, linhas, manual], indice) => {
  const id = `ped-${indice + 1}`;
  const itens: ItemPedido[] = linhas.map(([produtoN, quantidade], i) => {
    const p = PRODUTOS[produtoN - 1];
    return {
      id: `${id}-item-${i + 1}`,
      pedido_id: id,
      produto_id: p.id ?? '',
      quantidade,
      valor_unitario: p.preco,
      produto_nome: p.nome,
      produto_codigo: p.codigo,
    };
  });
  const frete = manual ? 0 : 24.9;
  const total = Math.round((itens.reduce((soma, item) => soma + item.quantidade * item.valor_unitario, 0) + frete) * 100) / 100;
  return {
    id,
    bling_id: String(180_000_482 - indice),
    numero: String(10_482 - indice),
    data: haDias(dias, 9 + (indice % 8)),
    total,
    status,
    cliente_id: `cli-${clienteN}`,
    origem: manual ? 'Loja Física / Manual' : 'Bling',
    frete,
    cliente: CLIENTES[clienteN - 1],
    itens,
    ...(status === 'Entregue' || status === 'Atendido'
      ? {
          nfe: {
            bling_id: String(190_000_482 - indice),
            numero: String(4_482 - indice),
            chave: `3526${String(11_000_000_000_000 + indice).padStart(14, '0')}55001${String(4_482 - indice).padStart(9, '0')}1000000000`,
            status: 'Autorizada',
            pedido_id: id,
            emitida_em: haDias(dias, 15),
          },
        }
      : {}),
    created_at: haDias(dias, 9 + (indice % 8)),
    updated_at: haDias(dias, 9 + (indice % 8)),
  };
});

const ativos = PEDIDOS.filter((p) => p.status !== 'Cancelado');
const naJanela = (de: number, ate: number) =>
  ativos.filter((p) => {
    const idade = (AGORA - new Date(p.data).getTime()) / DIA;
    return idade >= de && idade < ate;
  });
const soma = (pedidos: readonly PedidoEnriquecido[]) =>
  Math.round(pedidos.reduce((total, p) => total + p.total, 0) * 100) / 100;

export const DADOS_DO_PAINEL: DadosDoPainel = {
  pedidos: PEDIDOS,
  produtos: PRODUTOS,
  clientes: CLIENTES,
  categorias: CATEGORIAS,
  estatisticas: {
    faturamento30Dias: soma(naJanela(0, 30)),
    faturamento30DiasAnterior: soma(naJanela(30, 60)),
    totalPedidos: PEDIDOS.length,
    pendentes: PEDIDOS.filter((p) => p.status === 'Pendente').length,
    cancelados: PEDIDOS.filter((p) => p.status === 'Cancelado').length,
    atendidos: PEDIDOS.filter((p) => p.status === 'Atendido').length,
  },
};

const diaDe = (iso: string) => iso.slice(0, 10);

/** Cada pedido vira um título a receber; os cancelados entram como cancelados. */
const A_RECEBER: TituloFinanceiro[] = PEDIDOS.map((pedido, indice) => {
  const quitado = pedido.status === 'Entregue' || pedido.status === 'Atendido';
  return {
    id: `tit-r-${indice + 1}`,
    bling_id: 200_000_000 + indice,
    tipo: 'receber',
    situacao: pedido.status === 'Cancelado' ? 'cancelado' : quitado ? 'pago' : 'aberto',
    valor: pedido.total,
    data_vencimento: diaDe(pedido.data),
    ...(quitado ? { data_pagamento: diaDe(pedido.data) } : {}),
    titulo: `Pedido #${pedido.numero}`,
    descricao: `Pedido #${pedido.numero} - ${pedido.cliente?.nome ?? ''}`,
    categoria: { descricao: 'Vendas', cor: '#c6f432' },
    pedido_id: pedido.id,
  };
});

/** [dias atrás (negativo = a vencer), fornecedor, descrição, categoria, valor, pago?] */
const CONTAS: ReadonlyArray<readonly [number, string, string, string, number, boolean]> = [
  [-6, 'Ateliê Mãos da Mata', 'Lote de kuripes e tepis', 'Fornecedores', 1480, false],
  [-3, 'Vidros Verde Embalagens', 'Frascos 15ml e 20ml', 'Embalagens', 620, false],
  [-1, 'Contabilidade Horizonte', 'Honorários do mês', 'Serviços', 450, false],
  [2, 'Transportadora Rota Sul', 'Postagens da semana', 'Frete', 386.4, true],
  [4, 'Ervas da Serra', 'Ervas para defumador', 'Fornecedores', 940, true],
  [7, 'Gráfica Rótulo Bom', 'Rótulos e etiquetas', 'Embalagens', 312, true],
  [9, 'Transportadora Rota Sul', 'Postagens da semana', 'Frete', 402.7, true],
  [12, 'Anúncios online', 'Campanha do lote novo', 'Marketing', 800, true],
  [15, 'Sistema de gestão', 'Mensalidade', 'Serviços', 189.9, true],
  [18, 'Ateliê Mãos da Mata', 'Lote de kuripes', 'Fornecedores', 1260, true],
  [22, 'Transportadora Rota Sul', 'Postagens da semana', 'Frete', 358.2, true],
  [26, 'Vidros Verde Embalagens', 'Frascos e tampas', 'Embalagens', 540, true],
  [31, 'Contabilidade Horizonte', 'Honorários do mês', 'Serviços', 450, true],
  [37, 'Ervas da Serra', 'Ervas para defumador', 'Fornecedores', 880, true],
  [45, 'Anúncios online', 'Campanha de inverno', 'Marketing', 650, true],
  [51, 'Ateliê Mãos da Mata', 'Lote de tepis', 'Fornecedores', 1120, true],
];

const CORES_DE_DESPESA: Record<string, string> = {
  Fornecedores: '#ff6b5e',
  Embalagens: '#b9a3ff',
  Serviços: '#5ec8ff',
  Frete: '#ffb347',
  Marketing: '#ff8fd0',
};

const A_PAGAR: TituloFinanceiro[] = CONTAS.map(([dias, fornecedor, descricao, categoria, valor, pago], indice) => ({
  id: `tit-p-${indice + 1}`,
  bling_id: 210_000_000 + indice,
  tipo: 'pagar',
  situacao: pago ? 'pago' : 'aberto',
  valor,
  data_vencimento: diaDe(haDias(dias)),
  ...(pago ? { data_pagamento: diaDe(haDias(dias)) } : {}),
  titulo: descricao,
  descricao: `${descricao} - ${fornecedor}`,
  categoria: { descricao: categoria, cor: CORES_DE_DESPESA[categoria] },
  fornecedor_bling_id: 220_000_000 + indice,
  fornecedor_nome: fornecedor,
}));

const TITULOS: TituloFinanceiro[] = [...A_RECEBER, ...A_PAGAR].sort((a, b) =>
  b.data_vencimento.localeCompare(a.data_vencimento),
);

function leituraFinanceira(tipo: string | null) {
  const vivos = TITULOS.filter((t) => t.situacao === 'aberto' || t.situacao === 'pago');
  const total = (qual: 'receber' | 'pagar') =>
    Math.round(vivos.filter((t) => t.tipo === qual).reduce((soma, t) => soma + t.valor, 0) * 100) / 100;
  const receitas = total('receber');
  const despesas = total('pagar');
  return {
    titulos: tipo === 'receber' || tipo === 'pagar' ? TITULOS.filter((t) => t.tipo === tipo) : TITULOS,
    resumo: { receitas, despesas, saldo: Math.round((receitas - despesas) * 100) / 100 },
    categorias: ['Vendas', ...Object.keys(CORES_DE_DESPESA)].map((descricao, i) => ({ id: `catfin-${i + 1}`, descricao })),
  };
}

/** O detalhe de pedido no formato que o drawer espera receber do ERP. */
function detalheDoPedido(blingId: string): BlingPedido | null {
  const pedido = PEDIDOS.find((p) => p.bling_id === blingId);
  if (!pedido) return null;
  const cliente = pedido.cliente;
  return {
    id: Number(pedido.bling_id),
    numero: Number(pedido.numero),
    data: pedido.data,
    total: pedido.total,
    // A rota do produto devolve aqui o rótulo da situação, e é ele que o drawer mostra.
    situacao: { id: 0, valor: pedido.status as unknown as number },
    contato: {
      id: Number(cliente?.bling_id ?? 0),
      nome: cliente?.nome ?? '',
      numeroDocumento: cliente?.cpf_cnpj,
      tipoPessoa: cliente?.tipo === 'J' ? 'J' : 'F',
    },
    itens: (pedido.itens ?? []).map((item) => ({
      codigo: item.produto_codigo ?? undefined,
      descricao: item.produto_nome,
      unidade: 'UN',
      quantidade: item.quantidade,
      valor: item.valor_unitario,
      produto: { id: Number(PRODUTOS.find((p) => p.id === item.produto_id)?.bling_id ?? 0) },
    })),
    transporte: {
      frete: pedido.frete,
      etiqueta: {
        nome: cliente?.nome,
        endereco: cliente?.endereco,
        numero: cliente?.numero,
        bairro: cliente?.bairro,
        municipio: cliente?.cidade,
        uf: cliente?.uf,
        cep: cliente?.cep,
      },
    },
    observacoes: 'Pedido de demonstração.',
  };
}

function json(corpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(corpo), { status, headers: { 'Content-Type': 'application/json' } });
}

function respostaDaApi(caminho: string): Response {
  const pedido = /^\/api\/bling\/pedidos\/([^/?]+)/.exec(caminho);
  if (pedido) {
    const detalhe = detalheDoPedido(decodeURIComponent(pedido[1]));
    return detalhe ? json({ success: true, data: detalhe }) : json({ error: 'Pedido não encontrado' }, 404);
  }
  if (caminho.startsWith('/api/financeiro/operacoes')) {
    return json({ success: true, operacoes: [], total: 0, incompleta: false, proximoCursor: null });
  }
  if (/^\/api\/financeiro(\?|$)/.test(caminho)) {
    const tipo = new URLSearchParams(caminho.split('?')[1] ?? '').get('tipo');
    return json({ success: true, data: leituraFinanceira(tipo) });
  }
  if (caminho.startsWith('/api/categorias')) return json({ success: true, data: CATEGORIAS });
  if (caminho.startsWith('/api/produtos/bling/')) {
    return json({ success: true, obrigatorios: { tipo: 'P', situacao: 'A', formato: 'S', unidade: 'UN' } });
  }
  return json({ success: true, data: [] });
}

let instalado = false;

/**
 * Isola a aba da demonstração da rede: toda chamada a `/api/*` é respondida
 * daqui, e a leitura de sessão devolve uma sessão de mentira.
 *
 * Só vale para a aba que abriu `/demo` — a troca é em memória, some no reload
 * e nunca alcança o servidor.
 */
export function isolarDaRede(): void {
  if (instalado || typeof window === 'undefined') return;
  instalado = true;

  const sessaoDeDemo = { data: { session: { access_token: 'demo' } }, error: null };
  supabase.auth.getSession = (async () => sessaoDeDemo) as unknown as typeof supabase.auth.getSession;

  const fetchReal = window.fetch.bind(window);
  window.fetch = async (entrada, opcoes) => {
    const url = typeof entrada === 'string' ? entrada : entrada instanceof URL ? entrada.href : entrada.url;
    const caminho = url.startsWith('http') ? new URL(url).pathname + new URL(url).search : url;
    if (caminho.startsWith('/api/')) return respostaDaApi(caminho);
    return fetchReal(entrada, opcoes);
  };
}
