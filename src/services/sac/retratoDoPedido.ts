/**
 * O retrato de um pedido do cliente confirmado na conversa (MSG-011).
 *
 * O banco (migration 93) prende a leitura ao cliente da prova vigente e
 * devolve os fatos crus: pedido, itens com o estoque do produto, o título a
 * receber e quando cada fonte foi sincronizada. Aqui eles viram o contrato:
 * disponível é saldo menos reservas, pagamento só vem de título, rastreio é
 * desconhecido (o ORBITA não guarda rastreio) e dado velho é dito velho.
 *
 * A leitura não escreve e não sincroniza. Se o espelho está atrasado, o
 * retrato diz isso; buscar no Bling é outra operação, de outro dono.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

import type { EstoqueDoItem, Frescor, PagamentoDoRetrato, RetratoDoPedido } from '@/lib/integrations/contratoDoRetrato';
import { SITUACAO_DA_CONTA_BLING } from '@/lib/integrations/bling/situacaoDaContaBling';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';

import { VerificacaoIndisponivel } from './clienteVerificado';

/** Espelho sincronizado há mais tempo que isso não sustenta resposta ao cliente. */
export const IDADE_MAXIMA_DO_ESPELHO_MS = 24 * 60 * 60 * 1000;

const LIMITE_DE_ITENS = 50;
/** O vencimento é um dia do calendário de Brasília; comparar com o dia em UTC venceria o título três horas antes. */
const DIA_EM_BRASILIA = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' });
const numero = z.coerce.number().refine(Number.isFinite);
const instante = z.string().min(1);

const ItemCruSchema = z.strictObject({
  item_id: z.string().uuid(),
  produto_id: z.string().uuid().nullable(),
  nome: z.string(),
  codigo: z.string().nullable(),
  quantidade: z.number().int().positive(),
  valor_unitario: numero,
  produto_situacao: z.enum(['ativo', 'inativo', 'arquivado']).nullable(),
  estoque: z.number().int().nonnegative().nullable(),
  estoque_reservado: z.number().int().nonnegative().nullable(),
  produto_atualizado_em: instante.nullable(),
});

const RetratoCruSchema = z.strictObject({
  resultado: z.literal('retrato'),
  pedido: z.strictObject({
    pedido_id: z.string().uuid(),
    numero: z.string().nullable(),
    data: instante,
    status: z.string(),
    total: numero,
    frete: numero.nullable(),
    desconto: numero.nullable(),
    forma_pagamento: z.string().nullable(),
    atualizado_em: instante,
  }),
  itens: z.array(ItemCruSchema).max(LIMITE_DE_ITENS),
  total_de_itens: z.number().int().nonnegative(),
  titulo: z.strictObject({
    situacao: z.enum(['aberto', 'pago', 'cancelado', 'estornado']),
    situacao_bling: z.number().int().min(1).max(7).nullable(),
    valor: numero,
    vencimento: z.string().nullable(),
    pago_em: z.string().nullable(),
    atualizado_em: instante.nullable(),
  }).nullable(),
  sincronizacao: z.strictObject({
    pedidos: instante.nullable(),
    produtos: instante.nullable(),
    financeiro: instante.nullable(),
    ultimo_job: z.strictObject({ status: z.enum(['completed', 'failed']), em: instante.nullable() }).nullable(),
  }),
});
export type RetratoCru = z.infer<typeof RetratoCruSchema>;

const RecusaCruaSchema = z.strictObject({ resultado: z.enum(['sem_prova', 'nao_encontrado', 'conversa_inexistente']) });

function estoqueDe(item: z.infer<typeof ItemCruSchema>): EstoqueDoItem {
  if (item.produto_id === null || item.produto_situacao === null || item.estoque === null || item.estoque_reservado === null) {
    return { situacao: 'desconhecido', disponivel: null };
  }
  if (item.produto_situacao !== 'ativo') return { situacao: item.produto_situacao, disponivel: null };
  const disponivel = Math.max(item.estoque - item.estoque_reservado, 0);
  return { situacao: disponivel > 0 ? 'disponivel' : 'indisponivel', disponivel };
}

/** O código do Bling, quando há, decide; sem ele, a situação local. Código que não prova pagamento é desconhecido. */
function situacaoDoTitulo(titulo: NonNullable<RetratoCru['titulo']>): PagamentoDoRetrato['situacao'] {
  switch (titulo.situacao_bling) {
    case SITUACAO_DA_CONTA_BLING.aberto: return 'em_aberto';
    case SITUACAO_DA_CONTA_BLING.pago: return 'pago';
    case SITUACAO_DA_CONTA_BLING.parcial: return 'parcial';
    case SITUACAO_DA_CONTA_BLING.devolvido:
    case SITUACAO_DA_CONTA_BLING.devolvidoParcial: return 'devolvido';
    case SITUACAO_DA_CONTA_BLING.cancelado: return 'cancelado';
    case SITUACAO_DA_CONTA_BLING.confirmado: return 'desconhecido';
    default: break;
  }
  switch (titulo.situacao) {
    case 'aberto': return 'em_aberto';
    case 'pago': return 'pago';
    case 'cancelado': return 'cancelado';
    case 'estornado': return 'devolvido';
  }
}

function pagamentoDe(titulo: RetratoCru['titulo'], agora: Date): PagamentoDoRetrato {
  if (titulo === null) return { situacao: 'desconhecido', vencido: false, valor: null, vencimento: null, pagoEm: null };
  const situacao = situacaoDoTitulo(titulo);
  const hoje = DIA_EM_BRASILIA.format(agora);
  return {
    situacao,
    vencido: situacao === 'em_aberto' && titulo.vencimento !== null && titulo.vencimento < hoje,
    valor: titulo.valor,
    vencimento: titulo.vencimento,
    pagoEm: titulo.pago_em,
  };
}

/**
 * Atual só com sincronização boa há menos de 24 horas e sem falha depois dela.
 * `ultimoJob` só vale para pedidos e produtos: o financeiro sincroniza por outro caminho.
 */
function frescorDe(sincronizadoEm: string | null, ultimoJob: RetratoCru['sincronizacao']['ultimo_job'], agora: Date): Frescor {
  if (sincronizadoEm === null) return { situacao: 'desconhecido', sincronizadoEm: null, motivo: 'sem_sincronizacao' };
  const boa = Date.parse(sincronizadoEm);
  if (!Number.isFinite(boa)) return { situacao: 'desconhecido', sincronizadoEm: null, motivo: 'sem_sincronizacao' };
  const falhou = ultimoJob?.status === 'failed' && ultimoJob.em !== null && Date.parse(ultimoJob.em) > boa;
  if (falhou) return { situacao: 'desatualizado', sincronizadoEm, motivo: 'ultima_sincronizacao_falhou' };
  if (agora.getTime() - boa > IDADE_MAXIMA_DO_ESPELHO_MS) return { situacao: 'desatualizado', sincronizadoEm, motivo: 'antiga' };
  return { situacao: 'atual', sincronizadoEm, motivo: null };
}

/** Os fatos crus do banco no formato do contrato. Puro: o relógio entra como parâmetro. */
export function montarRetrato(cru: RetratoCru, agora: Date): RetratoDoPedido {
  const { pedido, sincronizacao } = cru;
  return {
    pedido: {
      id: pedido.pedido_id,
      numero: pedido.numero,
      data: pedido.data,
      status: pedido.status,
      total: pedido.total,
      frete: pedido.frete,
      desconto: pedido.desconto,
      formaDePagamento: pedido.forma_pagamento,
    },
    itens: cru.itens.map((item) => ({
      id: item.item_id,
      produtoId: item.produto_id,
      nome: item.nome,
      codigo: item.codigo,
      quantidade: item.quantidade,
      valorUnitario: item.valor_unitario,
      estoque: estoqueDe(item),
    })),
    totalDeItens: cru.total_de_itens,
    itensOmitidos: Math.max(cru.total_de_itens - cru.itens.length, 0),
    pagamento: pagamentoDe(cru.titulo, agora),
    rastreio: { situacao: 'desconhecido', motivo: 'sem_fonte' },
    frescor: {
      pedido: frescorDe(sincronizacao.pedidos, sincronizacao.ultimo_job, agora),
      estoque: frescorDe(sincronizacao.produtos, sincronizacao.ultimo_job, agora),
      pagamento: frescorDe(sincronizacao.financeiro, null, agora),
    },
  };
}

/** Sem prova só tem uma continuação: um atendente. Pedido alheio e inexistente são a mesma resposta. */
export type ResultadoDoRetrato =
  | { readonly _tag: 'Retrato'; readonly retrato: RetratoDoPedido }
  | { readonly _tag: 'NaoEncontrado' }
  | { readonly _tag: 'SemProva'; readonly proximoPasso: 'encaminhar_para_humano' }
  | { readonly _tag: 'ConversaNaoEncontrada' };

/**
 * Lê o retrato de um pedido do cliente confirmado na conversa. A organização
 * vem do escopo verificado; o cliente, da prova gravada. Resposta fora do
 * contrato (inclusive com campo a mais) é indisponibilidade, nunca retrato.
 */
export async function lerRetratoDoPedido(
  supabase: SupabaseClient,
  scope: VerifiedOrganizationScope,
  conversaId: string,
  pedidoId: string,
  agora: Date = new Date(),
): Promise<ResultadoDoRetrato> {
  const { data, error } = await supabase.rpc('retrato_do_pedido_verificado_sac', {
    p_organizacao_id: scope.organizationId,
    p_conversa_id_local: conversaId,
    p_pedido_id: pedidoId,
  });
  if (error) throw new VerificacaoIndisponivel();

  const recusa = RecusaCruaSchema.safeParse(data);
  if (recusa.success) {
    switch (recusa.data.resultado) {
      case 'sem_prova': return { _tag: 'SemProva', proximoPasso: 'encaminhar_para_humano' };
      case 'nao_encontrado': return { _tag: 'NaoEncontrado' };
      case 'conversa_inexistente': return { _tag: 'ConversaNaoEncontrada' };
    }
  }
  const cru = RetratoCruSchema.safeParse(data);
  if (!cru.success) throw new VerificacaoIndisponivel();
  return { _tag: 'Retrato', retrato: montarRetrato(cru.data, agora) };
}
