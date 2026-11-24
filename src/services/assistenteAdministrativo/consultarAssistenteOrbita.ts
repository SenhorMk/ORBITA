import { z } from 'zod';

import { apenasVendasAtivas } from '@/lib/metricas/vendasAtivas';
import type { leiturasDoAssistente } from '@/repositories/leiturasDoAssistenteOrbita';
import { responderConsultaDeEstoque } from './responderConsultaDeEstoque';
import type { FerramentaAssistente, PeriodoAssistente, RespostaAssistente } from './contratoAssistenteOrbita';

type LerEstoque = Parameters<typeof responderConsultaDeEstoque>[2];
type Leituras = ReturnType<typeof leiturasDoAssistente>;

interface Dependencias {
  leituras: Leituras;
  estoque: LerEstoque;
  detalheBling: (id: string) => Promise<unknown>;
}

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const casas = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 3 });
const fonte = 'Pedidos e estoque do ORBITA';
const janelaDia = 86_400_000;
const dataBling = z.string().date();
const detalheBling = z.object({
  id: z.number().int().positive(),
  dataSaida: z.string().nullish(),
  dataPrevista: z.string().nullish(),
  itens: z.array(z.object({
    descricao: z.string().trim().max(300),
    quantidade: z.number().finite(),
    valor: z.number().finite().nullish(),
  })).optional(),
  transporte: z.object({
    volumes: z.array(z.object({
      servico: z.string().trim().max(120).nullish(),
      codigoRastreamento: z.string().trim().max(80).nullish(),
    })).optional(),
  }).nullish(),
}).strip();

function diaLocal(data: string) {
  return data.split('-').reverse().join('/');
}

function intervalo(entrada: PeriodoAssistente, hoje: string) {
  const fim = entrada.tipo === 'dias' ? hoje : entrada.fim;
  const inicio = entrada.tipo === 'dias'
    ? new Date(Date.parse(hoje + 'T00:00:00Z') - (entrada.dias - 1) * janelaDia).toISOString().slice(0, 10)
    : entrada.inicio;
  const primeiro = Date.parse(inicio + 'T00:00:00Z');
  const ultimo = Date.parse(fim + 'T00:00:00Z');
  if (primeiro > ultimo || fim > hoje || ultimo - primeiro >= 90 * janelaDia) return null;
  return { inicio, fim, fimExclusivo: new Date(ultimo + janelaDia).toISOString().slice(0, 10) };
}

function ranking(itens: Awaited<ReturnType<Leituras['itensDasVendas']>>, ordenar: 'quantidade' | 'valor') {
  const produtos = new Map<string, { nome: string; quantidade: number; valor: number }>();
  for (const item of new Map(itens.map(i => [i.id, i])).values()) {
    const nome = item.produto_nome?.trim() || 'Produto sem nome';
    const produto = item.produto_id ?? nome.toLowerCase();
    const acumulado = produtos.get(produto) ?? { nome, quantidade: 0, valor: 0 };
    acumulado.quantidade += item.quantidade;
    acumulado.valor += Math.round(item.quantidade * (item.valor_unitario ?? 0) * 100);
    produtos.set(produto, acumulado);
  }
  return [...produtos.values()].sort((a, b) => b[ordenar] - a[ordenar] || a.nome.localeCompare(b.nome));
}

/**
 * Também é a resposta de um pedido relativo de estoque ("aumente em 3"), que a
 * trava de `selecionarFerramenta` transforma em esclarecer: por isso explica
 * como pedir uma alteração, e não só uma consulta.
 */
export const MENSAGEM_ESCLARECER = 'Não consegui identificar o pedido. Para consultar, indique o período, o produto (nome ou SKU) '
  + 'ou o número do pedido. Para alterar um produto, diga o valor final, por exemplo: "defina o estoque do SKU X para 10" '
  + 'ou "mude o nome do SKU X para Y". Somar ou retirar unidades não é feito por aqui: informe o saldo final.';

/** O assistente prepara edições de estoque, nome e descrição (com confirmação); o resto fica nos painéis. */
export const MENSAGEM_FORA_DO_ESCOPO = 'Posso consultar vendas, produtos, estoque, pedidos e rastreio, e preparar alterações de estoque, '
  + 'nome ou descrição de produtos para você confirmar. Para outras alterações, use o painel correspondente.';

export async function consultarAssistente(
  ferramenta: FerramentaAssistente, pergunta: string, hoje: string, deps: Dependencias,
): Promise<RespostaAssistente> {
  switch (ferramenta.acao) {
    case 'editar_produtos':
      return { mensagem: 'A prévia de edição deve ser preparada pelo fluxo administrativo autenticado.' };
    case 'vendas_do_periodo':
    case 'produtos_mais_vendidos': {
      const periodo = intervalo(ferramenta.periodo, hoje);
      if (!periodo) return { mensagem: 'Informe um período de até 90 dias, com fim até hoje.' };
      const vendas = apenasVendasAtivas(await deps.leituras.vendasNoPeriodo(periodo.inicio, periodo.fimExclusivo));
      const legenda = diaLocal(periodo.inicio) + ' a ' + diaLocal(periodo.fim);
      const status = [...new Set(vendas.map(pedido => pedido.status || 'Sem status'))].sort();
      if (!vendas.length) return { mensagem: 'Nenhum pedido ativo de ' + legenda + '.', fonte };
      if (ferramenta.acao === 'vendas_do_periodo') {
        const centavos = vendas.reduce((total, pedido) => total + Math.round((pedido.total ?? 0) * 100), 0);
        return {
          mensagem: 'De ' + legenda + ', ' + (vendas.length === 1 ? 'houve 1 pedido ativo' : 'houve ' + vendas.length + ' pedidos ativos') + ', somando ' + brl.format(centavos / 100) + '.',
          detalhes: ['Ticket médio ' + brl.format(centavos / vendas.length / 100), 'Status incluídos — ' + status.join(', ')],
          fonte,
        };
      }
      const itens = await deps.leituras.itensDasVendas(vendas.map(pedido => pedido.id));
      const produtos = ranking(itens, ferramenta.ordenar);
      if (!produtos.length) return { mensagem: 'Não encontrei itens sincronizados nos pedidos ativos de ' + legenda + '.', fonte };
      return {
        mensagem: 'Produtos mais vendidos por ' + ferramenta.ordenar + ', de ' + legenda + '.',
        detalhes: produtos.slice(0, 10).map(p => p.nome + ' · ' + casas.format(p.quantidade) + ' un. · ' + brl.format(p.valor / 100)),
        fonte: 'Itens dos pedidos ativos do ORBITA, valor bruto de linha',
      };
    }
    case 'consultar_estoque': {
      const saldo = await responderConsultaDeEstoque({ acao: 'consultar', produto: ferramenta.referencia }, pergunta, deps.estoque);
      if (saldo.estado === 'ambiguo') return {
        mensagem: saldo.mensagem, fonte, detalhes: saldo.candidatos.map(p => [p.nome, p.codigo].filter(Boolean).join(' · ')),
      };
      if (saldo.estado !== 'ok') return { mensagem: saldo.mensagem, fonte };
      const p = saldo.produto;
      return { mensagem: p.nome + ' tem ' + p.disponivel + ' unidades disponíveis.', fonte,
        detalhes: [p.codigo ? 'SKU ' + p.codigo : 'SKU indisponível', p.fisico + ' físicas · ' + p.reservado + ' reservadas'] };
    }
    case 'estoque_baixo': {
      const produtos = await deps.leituras.estoqueBaixo(ferramenta.limite);
      return { mensagem: produtos.length ? produtos.length + ' produtos com até ' + ferramenta.limite + ' unidades disponíveis.'
        : 'Nenhum produto com saldo confirmado até ' + ferramenta.limite + ' unidades.',
      fonte, detalhes: produtos.slice(0, 10).map(p => p.nome + ' · ' + p.disponivel + ' disponíveis') };
    }
    case 'consultar_pedido':
    case 'consultar_rastreamento': {
      if (!pergunta.match(/\d+/gu)?.includes(ferramenta.referencia)) return { mensagem: 'Informe o número comercial ou o ID do Bling.' };
      const pedidos = await deps.leituras.pedido(ferramenta.referencia, ferramenta.por);
      if (pedidos.length > 1) return { mensagem: 'Há mais de um pedido com esse número. Informe o ID do Bling.', fonte };
      if (!pedidos.length) return { mensagem: 'Pedido não encontrado na organização ativa.', fonte };
      const [pedido] = pedidos;
      const rotulo = 'Pedido ' + (pedido.numero || pedido.bling_id);
      if (ferramenta.acao === 'consultar_pedido') {
        const itens = await deps.leituras.itensDasVendas([pedido.id]);
        const detalhes = [pedido.total === null ? 'Valor indisponível' : 'Total ' + brl.format(pedido.total)];
        if (pedido.cliente_id) detalhes.push('Há um cliente vinculado ao pedido.');
        let origem = fonte;
        if (itens.length) {
          detalhes.push(...itens.slice(0, 12).map(i =>
            (i.produto_nome || 'Produto sem nome') + ' · ' + casas.format(i.quantidade) + ' un.'));
        } else if (/^\d{1,18}$/u.test(pedido.bling_id)) {
          try {
            const remoto = detalheBling.safeParse(await deps.detalheBling(pedido.bling_id));
            if (remoto.success && String(remoto.data.id) === pedido.bling_id && remoto.data.itens?.length) {
              origem = 'ORBITA e detalhe do pedido no Bling';
              detalhes.push(...remoto.data.itens.slice(0, 12).map(i => i.descricao + ' · ' + casas.format(i.quantidade) + ' un.'));
            } else {
              detalhes.push('Itens não confirmados neste pedido.');
            }
          } catch {
            detalhes.push('Bling indisponível para confirmar os itens.');
          }
        } else {
          detalhes.push('Itens locais indisponíveis.');
        }
        return { mensagem: rotulo + ' · ' + (pedido.status || 'Status sem informação') + '.', detalhes, fonte: origem };
      }
      if (!/^\d{1,18}$/u.test(pedido.bling_id)) return { mensagem: rotulo + ' não tem referência de expedição no Bling.', fonte };
      let expedicao;
      try {
        expedicao = detalheBling.safeParse(await deps.detalheBling(pedido.bling_id));
      } catch {
        return { mensagem: 'Encontrei o pedido, mas o Bling está indisponível para consultar o rastreio.', fonte };
      }
      if (!expedicao.success || String(expedicao.data.id) !== pedido.bling_id) {
        return { mensagem: 'O Bling não retornou um detalhe válido para confirmar o rastreio deste pedido.', fonte };
      }
      const codigos = [...new Set((expedicao.data.transporte?.volumes ?? [])
        .map(v => v.codigoRastreamento).filter(c => c && /^[a-zA-Z0-9-]{5,80}$/u.test(c)))];
      const saida = dataBling.safeParse(expedicao.data.dataSaida);
      const prevista = dataBling.safeParse(expedicao.data.dataPrevista);
      const detalhes = codigos.map(c => String(c));
      if (saida.success) detalhes.push('Saída registrada pelo Bling em ' + diaLocal(saida.data));
      if (prevista.success) detalhes.push('Data prevista cadastrada no Bling: ' + diaLocal(prevista.data));
      return { mensagem: codigos.length ? 'Rastreio cadastrado no Bling para o ' + rotulo.toLowerCase() + '.'
        : 'O Bling não informou código de rastreio para este pedido.',
      detalhes, fonte: 'Detalhe do pedido consultado no Bling' };
    }
    case 'sem_fonte_procura':
      return { mensagem: 'O ORBITA não tem uma fonte de buscas ou interesse validada para calcular produtos mais procurados. Posso consultar os mais vendidos.' };
    case 'esclarecer':
      return { mensagem: MENSAGEM_ESCLARECER };
    case 'fora_do_escopo':
      return { mensagem: MENSAGEM_FORA_DO_ESCOPO };
  }
}
