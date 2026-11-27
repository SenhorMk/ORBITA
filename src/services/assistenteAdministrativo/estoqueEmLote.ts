import { escopoTemCapacidade, type VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import type { ItemEdicao, RespostaEdicao } from './edicaoDeProdutosContract';
import { pedidoEstoqueEmLote, type PedidoEstoqueEmLote } from './estoqueEmLoteContract';
import type { PortasDeEdicao, ProdutoParaEdicao } from './editarProdutos';
import { decidirProduto, palavras, ranquearProdutos } from './rankingDeProdutos';

/** Resposta do lote: a prévia, ou o motivo e os itens que a pessoa precisa resolver. */
export type RespostaDeLote = RespostaEdicao & { readonly detalhes?: readonly string[] };

const ENTRADA = /\b(?:aument\w*|adicion\w*|acrescent\w*|som(?:e|a|ar|ando)|increment\w*|rep(?:or|oe|onha)|coloc\w*|bot(?:a|e|ar)|p(?:oe|onha)|entr(?:ou|aram|ada)|cheg(?:ou|aram)|receb\w*|mais)\b/u;
const SAIDA = /\b(?:diminu\w*|reduz\w*|retir\w*|tir(?:a|e|ar)|baix(?:a|e|ar|ando)|subtra\w*|decrement\w*|vend(?:i|eu|emos|eram)|sai(?:u|ram)|perd\w*|menos)\b/u;
const ABSOLUTO = /\b(?:defin\w*|deix\w*|fi(?:ca|que|car)|zer\w*|coloc\w*|pa?ra\s+\d+)\b/u;

function normalizar(texto: string) {
  return texto.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('pt-BR');
}

/**
 * O modelo só copia o que a pessoa escreveu. Recusa referência com palavra que não
 * está no pedido, número que não está no pedido e operação sem verbo compatível
 * (por exemplo, "definir" quando o pedido só fala em somar). Devolve o motivo ou null.
 * O produto pode vir das perguntas `anteriores` ("adiciona 5 nele"); número e verbo, só da atual.
 */
export function conferirPedidoDeLote(pedido: PedidoEstoqueEmLote, pergunta: string, anteriores: readonly string[] = []): string | null {
  const literal = normalizar(pergunta);
  const doPedido = palavras([...anteriores, pergunta].join('\n'));
  const numeros = new Set(literal.match(/\d+/gu) ?? []);
  for (const item of pedido.itens) {
    const ausente = palavras(item.referencia).some(p => !doPedido.some(d => d === p || d.startsWith(p) || p.startsWith(d)));
    if (ausente || !palavras(item.referencia).length) return 'Não encontrei “' + item.referencia + '” no seu pedido. Cite cada produto pelo nome ou SKU.';
    const zerar = item.quantidade === 0 && item.operacao === 'definir' && /\bzer\w*/u.test(literal);
    if (!zerar && !numeros.has(String(item.quantidade))) return 'Escreva a quantidade de cada produto em algarismos, por exemplo “adicione 5 no SKU X”.';
    const compativel = item.operacao === 'somar' ? ENTRADA.test(literal)
      : item.operacao === 'subtrair' ? SAIDA.test(literal)
        : ABSOLUTO.test(literal) || !(ENTRADA.test(literal) || SAIDA.test(literal));
    if (!compativel) return 'Não ficou claro se é para somar, retirar ou definir o saldo de “' + item.referencia + '”. Diga, por exemplo, “adicione 5”, “retire 2” ou “deixe em 10”.';
  }
  return null;
}

const indisponivel: RespostaDeLote = { mensagem: 'Não foi possível preparar a alteração. Nenhum comando foi enviado ao Bling.' };
const rotulo = (p: ProdutoParaEdicao) => p.nome + (p.codigo ? ' (' + p.codigo + ')' : '');

function saldoFinal(operacao: PedidoEstoqueEmLote['itens'][number]['operacao'], anterior: number, quantidade: number) {
  return operacao === 'definir' ? quantidade : operacao === 'somar' ? anterior + quantidade : anterior - quantidade;
}

/** Resolve cada referência no catálogo escopado, lê o saldo no Bling e guarda UMA proposta. Nada é enviado ao Bling aqui. */
export async function proporEstoqueEmLote(
  portas: PortasDeEdicao, scope: VerifiedOrganizationScope, entrada: PedidoEstoqueEmLote, pergunta: string,
  anteriores: readonly string[] = [],
): Promise<RespostaDeLote> {
  if (!escopoTemCapacidade(scope, 'organization:manage')) return { mensagem: 'A alteração exige permissão de gestão na organização ativa.' };
  const parsed = pedidoEstoqueEmLote.safeParse(entrada);
  if (!parsed.success) return indisponivel;
  const pedido = parsed.data;
  const motivo = conferirPedidoDeLote(pedido, pergunta, anteriores);
  if (motivo) return { mensagem: motivo };

  const catalogo = await portas.catalogo(scope);
  if (catalogo._tag !== 'ok') return indisponivel;
  const resolvidos: ProdutoParaEdicao[] = [];
  const pendencias: string[] = [];
  for (const item of pedido.itens) {
    const decisao = decidirProduto(ranquearProdutos(item.referencia, catalogo.valor));
    if (decisao.tipo === 'unico') resolvidos.push(decisao.candidato.produto);
    else if (decisao.tipo === 'nenhum') pendencias.push('“' + item.referencia + '”: nenhum produto parecido.');
    else pendencias.push('“' + item.referencia + '”: ' + decisao.total + ' parecidos — ' + decisao.candidatos.map(c => rotulo(c.produto)).join('; ') + '.');
  }
  if (pendencias.length) return {
    mensagem: 'Não preparei a prévia: estes itens não apontam para um único produto. Peça de novo usando o SKU ou o nome completo deles.',
    detalhes: pendencias,
  };
  if (new Set(resolvidos.map(p => p.id)).size !== resolvidos.length) {
    return { mensagem: 'O mesmo produto apareceu mais de uma vez no pedido. Junte as quantidades e peça de novo.' };
  }
  if (resolvidos.some(p => !/^\d{1,15}$/u.test(p.blingId))) return indisponivel;

  const deposito = await portas.deposito();
  if (deposito._tag !== 'ok') return indisponivel;
  if (!deposito.valor) return { mensagem: 'O ajuste exige um único depósito cadastrado, ativo e considerado no saldo do Bling. Use a gestão de estoque para escolher o depósito.' };

  const itens: ItemEdicao[] = [];
  const invalidos: string[] = [];
  const limite = portas.agora() + 230_000;
  for (const [i, produto] of resolvidos.entries()) {
    if (portas.agora() >= limite) return indisponivel;
    const remoto = await portas.ler(produto.blingId, 'estoque');
    if (remoto._tag !== 'ok' || remoto.valor.estoque === null) return indisponivel;
    const { operacao, quantidade } = pedido.itens[i];
    const valor = saldoFinal(operacao, remoto.valor.estoque, quantidade);
    if (valor < 0 || valor > 1_000_000 || !Number.isInteger(valor)) {
      invalidos.push(remoto.valor.nome + ': saldo ' + remoto.valor.estoque + (valor < 0
        ? ', retirar ' + quantidade + ' deixaria o estoque negativo.' : ', o saldo final passaria do limite de 1.000.000.'));
      continue;
    }
    itens.push({ produtoId: produto.id, blingId: produto.blingId, nome: remoto.valor.nome, codigo: produto.codigo,
      campo: 'estoque', anterior: remoto.valor.estoque, valor });
  }
  if (invalidos.length) return { mensagem: 'Não preparei a prévia: o saldo final de algum produto seria inválido.', detalhes: invalidos };

  const salva = await portas.guardar(scope, { itens, deposito: deposito.valor });
  if (salva._tag !== 'ok') return indisponivel;
  return {
    mensagem: 'Confira os ' + (itens.length === 1 ? 'dados do produto' : itens.length + ' produtos') + ' e o saldo final de cada um. O Bling só será alterado após sua confirmação.',
    proposta: salva.valor,
  };
}
