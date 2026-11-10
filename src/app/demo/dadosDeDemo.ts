/**
 * DEMONSTRAÇÃO — tudo aqui é inventado. Nenhum cliente, pedido ou produto existe.
 *
 * Este arquivo e a pasta `src/app/demo` inteira são descartáveis: apagar a pasta
 * remove a demonstração sem tocar no produto.
 */

import { supabase } from '@/lib/supabaseClient';
import type { DadosDoPainel } from '@/components/painel/useLeituraDoPainel';
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
  { id: 'cat-1', bling_id: '9001', descricao: 'Freios' },
  { id: 'cat-2', bling_id: '9002', descricao: 'Filtros' },
  { id: 'cat-3', bling_id: '9003', descricao: 'Suspensão' },
  { id: 'cat-4', bling_id: '9004', descricao: 'Elétrica' },
  { id: 'cat-5', bling_id: '9005', descricao: 'Lubrificantes' },
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
  produto(1, 'FR-1001', 'Kit pastilha de freio dianteira', 189.9, 14, 'cat-1'),
  produto(2, 'FR-1002', 'Disco de freio ventilado 280 mm', 329.0, 8, 'cat-1'),
  produto(3, 'FR-1003', 'Fluido de freio DOT 4 500 ml', 34.9, 62, 'cat-1'),
  produto(4, 'FI-2001', 'Filtro de óleo', 18.9, 240, 'cat-2'),
  produto(5, 'FI-2002', 'Filtro de ar do motor', 46.5, 95, 'cat-2'),
  produto(6, 'FI-2003', 'Filtro de combustível', 39.9, 71, 'cat-2'),
  produto(7, 'FI-2004', 'Filtro de cabine com carvão ativado', 58.0, 3, 'cat-2'),
  produto(8, 'SU-3001', 'Amortecedor dianteiro', 412.0, 12, 'cat-3'),
  produto(9, 'SU-3002', 'Kit batente e coifa', 79.9, 27, 'cat-3'),
  produto(10, 'SU-3003', 'Bandeja de suspensão inferior', 268.0, 0, 'cat-3'),
  produto(11, 'EL-4001', 'Bateria 60 Ah', 529.0, 9, 'cat-4'),
  produto(12, 'EL-4002', 'Jogo de velas de ignição', 124.9, 33, 'cat-4'),
  produto(13, 'EL-4003', 'Lâmpada H7 55 W (par)', 49.9, 118, 'cat-4'),
  produto(14, 'LU-5001', 'Óleo 5W30 sintético 1 L', 42.9, 186, 'cat-5'),
  produto(15, 'LU-5002', 'Aditivo de radiador 1 L', 27.5, 54, 'cat-5'),
  produto(16, 'LU-5003', 'Graxa de lítio 500 g', 31.0, 5, 'cat-5'),
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
  cliente(2, 'Auto Peças Ribeiro', '12.345.678/0001-00', '+55 31 99731-4420', 'Belo Horizonte', 'MG', 'Av. do Contorno'),
  cliente(3, 'Lucas Andrade', '234.567.890-00', '+55 21 99610-7734', 'Rio de Janeiro', 'RJ', 'Rua do Catete'),
  cliente(4, 'Mercado Bom Preço', '23.456.789/0001-00', '+55 41 98455-0912', 'Curitiba', 'PR', 'Rua XV de Novembro'),
  cliente(5, 'Camila Ferraz', '345.678.901-00', '+55 11 97120-3388', 'Campinas', 'SP', 'Rua Barão de Jaguara'),
  cliente(6, 'Distribuidora Aurora', '34.567.890/0001-00', '+55 62 99288-6601', 'Goiânia', 'GO', 'Av. Anhanguera'),
  cliente(7, 'Oficina do Tonho', '45.678.901/0001-00', '+55 51 99876-2210', 'Porto Alegre', 'RS', 'Av. Farrapos'),
  cliente(8, 'Rafael Monteiro', '456.789.012-00', '+55 71 98123-4409', 'Salvador', 'BA', 'Av. Sete de Setembro'),
  cliente(9, 'Centro Automotivo Veloz', '56.789.012/0001-00', '+55 85 99654-7781', 'Fortaleza', 'CE', 'Av. Santos Dumont'),
  cliente(10, 'Beatriz Nogueira', '567.890.123-00', '+55 48 99911-3052', 'Florianópolis', 'SC', 'Rua Bocaiúva'),
  cliente(11, 'Transportes Serra Azul', '67.890.123/0001-00', '+55 27 99745-8830', 'Vitória', 'ES', 'Av. Vitória'),
  cliente(12, 'Gustavo Prado', '678.901.234-00', '+55 81 98802-1946', 'Recife', 'PE', 'Rua da Aurora'),
];

/** [dias atrás, cliente, status, itens [produto, quantidade][], origem manual?] */
type Roteiro = readonly [number, number, string, ReadonlyArray<readonly [number, number]>, boolean?];

const ROTEIRO: readonly Roteiro[] = [
  [0, 1, 'Pendente', [[1, 1], [3, 2]]],
  [0, 2, 'Pendente', [[4, 40]]],
  [1, 7, 'Entregue', [[8, 2], [9, 2]]],
  [1, 4, 'Pendente', [[14, 24], [15, 12]]],
  [2, 9, 'Entregue', [[11, 3], [12, 4]]],
  [2, 3, 'Entregue', [[13, 2]], true],
  [3, 6, 'Entregue', [[4, 60], [5, 30], [6, 20]]],
  [4, 5, 'Entregue', [[2, 2], [1, 1]]],
  [5, 11, 'Entregue', [[14, 48], [16, 6]]],
  [6, 8, 'Cancelado', [[10, 1]]],
  [7, 2, 'Entregue', [[1, 6], [2, 4]]],
  [8, 10, 'Entregue', [[7, 1], [5, 1]], true],
  [9, 12, 'Atendido', [[12, 1], [13, 1]]],
  [10, 7, 'Atendido', [[8, 4]]],
  [11, 9, 'Atendido', [[3, 12], [1, 8]]],
  [13, 4, 'Atendido', [[14, 36]]],
  [14, 1, 'Atendido', [[5, 1], [4, 1]]],
  [16, 6, 'Atendido', [[11, 4]]],
  [18, 11, 'Cancelado', [[2, 2]]],
  [19, 3, 'Atendido', [[9, 1], [8, 2]]],
  [21, 2, 'Atendido', [[4, 80], [6, 24]]],
  [23, 5, 'Atendido', [[12, 1]], true],
  [25, 9, 'Atendido', [[1, 10], [3, 10]]],
  [27, 7, 'Atendido', [[15, 8], [16, 4]]],
  [29, 12, 'Atendido', [[13, 3]]],
  [33, 6, 'Atendido', [[4, 150], [5, 40]]],
  [36, 2, 'Atendido', [[1, 14], [2, 6]]],
  [40, 9, 'Atendido', [[11, 6]]],
  [44, 4, 'Atendido', [[14, 90]]],
  [48, 7, 'Atendido', [[8, 8]]],
  [52, 11, 'Atendido', [[2, 6], [3, 30]]],
  [57, 1, 'Atendido', [[12, 6], [11, 2]]],
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
    const caminho = url.startsWith('http') ? new URL(url).pathname : url;
    if (caminho.startsWith('/api/')) return respostaDaApi(caminho);
    return fetchReal(entrada, opcoes);
  };
}
