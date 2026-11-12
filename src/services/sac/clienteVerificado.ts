/**
 * Quem é a pessoa da conversa e o que se pode consultar dela (MSG-010).
 *
 * Telefone igual ao de um cliente é só candidato. A conversa passa a
 * `verificado` quando um atendente confirma o cliente (D2 pendente: o padrão
 * seguro é a verificação humana), e só então os pedidos desse cliente podem
 * ser consultados. A regra é do banco (migration 92); aqui ficam o contrato e
 * a recusa de qualquer resposta fora dele. Organização e ator vêm do escopo
 * verificado, nunca do corpo da requisição.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

import type { Candidato, PedidoDoCliente, Verificacao } from '@/lib/integrations/contratoDaVerificacao';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';

/** O banco não respondeu ou respondeu fora do contrato. Nunca é tratado como "sem prova". */
export class VerificacaoIndisponivel extends Error {
  constructor() {
    super('Não foi possível ler ou alterar a verificação do cliente.');
    this.name = 'VerificacaoIndisponivel';
  }
}

/** A linha (ou o valor) de uma função do banco, validada; qualquer desvio é indisponibilidade. */
async function chamar<T>(supabase: SupabaseClient, funcao: string, parametros: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
  const { data, error } = await supabase.rpc(funcao, parametros);
  if (error) throw new VerificacaoIndisponivel();
  const lido = schema.safeParse(data);
  if (!lido.success) throw new VerificacaoIndisponivel();
  return lido.data;
}

const umaLinha = <T extends z.ZodType>(linha: T) => z.array(linha).length(1).transform((linhas) => linhas[0]);

const contagens = { candidatos: z.number().int().nonnegative(), consulta_bloqueada: z.boolean() };
const LeituraSchema = umaLinha(z.union([
  z.object({ resultado: z.literal('conversa_inexistente') }),
  z.object({
    resultado: z.literal('encontrada'),
    estado: z.literal('verificado'),
    cliente_id: z.string().uuid(),
    cliente_nome: z.string(),
    verificado_em: z.string(),
    expira_em: z.string(),
    ...contagens,
  }),
  z.object({ resultado: z.literal('encontrada'), estado: z.enum(['sem_prova', 'expirada']), ...contagens }),
]));

const CandidatosSchema = z.array(z.object({
  cliente_id: z.string().uuid(),
  nome: z.string(),
  documento_final: z.string().regex(/^\d{2}$/u).nullable(),
}));

export type LeituraDaVerificacao =
  | { readonly _tag: 'Encontrada'; readonly verificacao: Verificacao; readonly candidatos: readonly Candidato[] }
  | { readonly _tag: 'ConversaNaoEncontrada' };

/** O estado da conversa e, havendo, os clientes com o telefone do contato. */
export async function lerVerificacao(
  supabase: SupabaseClient,
  scope: VerifiedOrganizationScope,
  conversaId: string,
): Promise<LeituraDaVerificacao> {
  const parametros = { p_organizacao_id: scope.organizationId, p_conversa_id_local: conversaId };
  const linha = await chamar(supabase, 'ler_verificacao_cliente_sac', parametros, LeituraSchema);
  if (linha.resultado === 'conversa_inexistente') return { _tag: 'ConversaNaoEncontrada' };

  const candidatos = linha.candidatos === 0
    ? []
    : (await chamar(supabase, 'listar_candidatos_cliente_sac', parametros, CandidatosSchema))
      .map((c) => ({ clienteId: c.cliente_id, nome: c.nome, documentoFinal: c.documento_final }));
  const verificado = linha.estado === 'verificado' ? linha : null;
  return {
    _tag: 'Encontrada',
    verificacao: {
      estado: linha.estado,
      cliente: verificado ? { id: verificado.cliente_id, nome: verificado.cliente_nome } : null,
      verificadoEm: verificado?.verificado_em ?? null,
      expiraEm: verificado?.expira_em ?? null,
      totalDeCandidatos: linha.candidatos,
      consultaPorNumeroBloqueada: linha.consulta_bloqueada,
    },
    candidatos,
  };
}

const ConfirmacaoSchema = umaLinha(z.discriminatedUnion('resultado', [
  z.object({ resultado: z.enum(['aplicado', 'existente']), vinculo_id: z.string().uuid(), expira_em: z.string() }),
  z.object({ resultado: z.enum(['conflito_comando', 'cliente_inexistente', 'conversa_inexistente', 'sem_vinculo']) }),
]));

export type ResultadoDaConfirmacao =
  | { readonly _tag: 'Confirmado'; readonly duplicado: boolean; readonly vinculoId: string; readonly expiraEm: string }
  | { readonly _tag: 'ConflitoDeComando' }
  | { readonly _tag: 'ClienteNaoEncontrado' }
  | { readonly _tag: 'ConversaNaoEncontrada' }
  | { readonly _tag: 'SemVinculo' };

/** O atendente confirma que a pessoa da conversa é este cliente. Substitui a confirmação anterior. */
export async function confirmarCliente(
  supabase: SupabaseClient,
  scope: VerifiedOrganizationScope,
  comando: { readonly conversaId: string; readonly commandId: string; readonly clienteId: string },
): Promise<ResultadoDaConfirmacao> {
  const linha = await chamar(supabase, 'confirmar_vinculo_cliente_sac', {
    p_organizacao_id: scope.organizationId,
    p_ator_id: scope.actorId,
    p_conversa_id_local: comando.conversaId,
    p_command_id: comando.commandId,
    p_cliente_id: comando.clienteId,
  }, ConfirmacaoSchema);

  switch (linha.resultado) {
    case 'aplicado':
    case 'existente':
      return { _tag: 'Confirmado', duplicado: linha.resultado === 'existente', vinculoId: linha.vinculo_id, expiraEm: linha.expira_em };
    case 'conflito_comando': return { _tag: 'ConflitoDeComando' };
    case 'cliente_inexistente': return { _tag: 'ClienteNaoEncontrado' };
    case 'conversa_inexistente': return { _tag: 'ConversaNaoEncontrada' };
    case 'sem_vinculo': return { _tag: 'SemVinculo' };
  }
}

const TAG_DA_REVOGACAO = {
  aplicado: 'Revogada',
  sem_prova: 'SemProva',
  conversa_inexistente: 'ConversaNaoEncontrada',
  sem_vinculo: 'SemVinculo',
} as const;
const RevogacaoSchema = z.enum(['aplicado', 'sem_prova', 'conversa_inexistente', 'sem_vinculo']);

export type ResultadoDaRevogacao = { readonly _tag: (typeof TAG_DA_REVOGACAO)[keyof typeof TAG_DA_REVOGACAO] };

/** Desfaz a confirmação vigente da conversa. Sem confirmação, nada muda. */
export async function revogarVerificacao(
  supabase: SupabaseClient,
  scope: VerifiedOrganizationScope,
  conversaId: string,
): Promise<ResultadoDaRevogacao> {
  const resultado = await chamar(supabase, 'revogar_vinculo_cliente_sac', {
    p_organizacao_id: scope.organizationId,
    p_ator_id: scope.actorId,
    p_conversa_id_local: conversaId,
  }, RevogacaoSchema);
  return { _tag: TAG_DA_REVOGACAO[resultado] };
}

const PedidosSchema = z.array(z.object({
  resultado: z.literal('pedido'),
  pedido_id: z.string().uuid(),
  numero: z.string().nullable(),
  data: z.string(),
  status: z.string(),
  total: z.coerce.number(),
})).min(1);
const RecusaSchema = umaLinha(z.object({
  resultado: z.enum(['sem_pedidos', 'nao_encontrado', 'bloqueada', 'sem_prova', 'conversa_inexistente']),
  pedido_id: z.null(),
}));

/**
 * Sem prova e consulta bloqueada só têm uma continuação: um atendente. A
 * automação não recebe candidato, motivo nem dado do cadastro para insistir.
 */
export type ResultadoDaConsulta =
  | { readonly _tag: 'Pedidos'; readonly pedidos: readonly PedidoDoCliente[] }
  | { readonly _tag: 'NaoEncontrado' }
  | { readonly _tag: 'SemProva'; readonly proximoPasso: 'encaminhar_para_humano' }
  | { readonly _tag: 'Bloqueada'; readonly proximoPasso: 'encaminhar_para_humano' }
  | { readonly _tag: 'ConversaNaoEncontrada' };

export interface ConsultaDePedidos {
  /** Os pedidos mais recentes do cliente confirmado na conversa. */
  listar(): Promise<ResultadoDaConsulta>;
  /** Um número de pedido, procurado só entre os do cliente confirmado. */
  localizar(numero: string): Promise<ResultadoDaConsulta>;
}

/**
 * A consulta de pedidos presa a uma conversa. Quem a usa (a tela do atendente
 * hoje, as ferramentas da automação depois) não escolhe organização nem
 * cliente: a organização vem do escopo verificado e o cliente, da prova
 * gravada. Pedido alheio, de outra organização e inexistente são a mesma
 * resposta.
 */
export function criarConsultaDePedidos(
  supabase: SupabaseClient,
  scope: VerifiedOrganizationScope,
  conversaId: string,
): ConsultaDePedidos {
  const consultar = async (numero: string | null): Promise<ResultadoDaConsulta> => {
    const resposta = await chamar(supabase, 'consultar_pedidos_do_cliente_verificado_sac', {
      p_organizacao_id: scope.organizationId,
      p_conversa_id_local: conversaId,
      p_numero: numero,
    }, z.union([PedidosSchema, RecusaSchema]));

    if (Array.isArray(resposta)) {
      return {
        _tag: 'Pedidos',
        pedidos: resposta.map((p) => ({ id: p.pedido_id, numero: p.numero, data: p.data, status: p.status, total: p.total })),
      };
    }
    switch (resposta.resultado) {
      case 'sem_pedidos': return { _tag: 'Pedidos', pedidos: [] };
      case 'nao_encontrado': return { _tag: 'NaoEncontrado' };
      case 'sem_prova': return { _tag: 'SemProva', proximoPasso: 'encaminhar_para_humano' };
      case 'bloqueada': return { _tag: 'Bloqueada', proximoPasso: 'encaminhar_para_humano' };
      case 'conversa_inexistente': return { _tag: 'ConversaNaoEncontrada' };
    }
  };
  return {
    listar: () => consultar(null),
    localizar: (numero) => consultar(numero),
  };
}
