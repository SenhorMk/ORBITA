import { supabaseServer } from '@/lib/supabaseServer';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import { registrarFalhaInterna } from '@/lib/observability/falhaInterna';

import type {
  FinalizacaoDeIntervencao,
  FinalizacaoResultado,
  ReivindicacaoDeIntervencao,
  ResolucaoDeAmbiguidade,
  ResolucaoDeIntervencaoAmbigua,
  TentativaRegistrada,
  TomadaDePosse,
} from './ports';

/**
 * Adapters Supabase da RECONCILIAÇÃO: tomada de posse, claim de intervenção e
 * finalização atômica (ticket 30, fatia 3 — 7ª e 8ª rodadas de revisão).
 *
 * Separados de `dependencias.ts` quando aquele arquivo passou do limite de
 * tamanho do gate de qualidade. A fronteira é natural: aqui vive só o que a
 * reconciliação usa, e nada do caminho normal da venda.
 */

/**
 * Toma a posse de uma tentativa antiga, cercando o executor anterior.
 *
 * `55P03` é a posse negada: outro executor tomou primeiro, ou a época já
 * avançou. Vira valor, não exceção, porque quem chamou precisa distinguir
 * "não sou dono" de "não deu para saber".
 */
export async function assumirTentativaParaReconciliacao(
  scope: VerifiedOrganizationScope,
  tentativaId: string,
  epocaEsperada: number,
  estadoEsperado: TentativaRegistrada['estado'],
): Promise<TomadaDePosse> {
  const { data, error } = await supabaseServer.rpc('assumir_tentativa_para_reconciliacao', {
    p_organizacao_id: scope.organizationId,
    p_tentativa_id: tentativaId,
    p_epoca_esperada: epocaEsperada,
    p_estado_esperado: estadoEsperado,
  });

  if (error?.code === '55P03') return { _tag: 'PosseNegada' };
  if (error) return { _tag: 'PosseIndisponivel', causa: new Error(`Falha ao assumir a tentativa: ${error.message}`) };
  if (typeof data !== 'number') {
    return { _tag: 'PosseIndisponivel', causa: new Error('assumir_tentativa_para_reconciliacao não devolveu a época') };
  }
  return { _tag: 'PosseTomada', epoca: data };
}

/**
 * Reivindica o direito de intervir — o claim que impede duas intervenções
 * externas simultâneas sobre a mesma tentativa.
 *
 * `55006` é o índice único parcial recusando uma segunda intervenção em voo
 * (ou uma anterior que ficou AMBÍGUA, que também bloqueia).
 */
export async function reivindicarIntervencao(
  scope: VerifiedOrganizationScope,
  tentativaId: string,
  acao: 'cancelar-no-bling',
  blingPedidoId: string | null,
): Promise<ReivindicacaoDeIntervencao> {
  const { data, error } = await supabaseServer.rpc('reivindicar_intervencao_venda_manual', {
    p_organizacao_id: scope.organizationId,
    p_tentativa_id: tentativaId,
    p_acao: acao,
    p_ator_id: scope.actorId,
    p_bling_pedido_id: blingPedidoId,
  });

  if (error?.code === '55006') return { _tag: 'IntervencaoJaEmAndamento' };
  if (error) {
    return { _tag: 'IntervencaoIndisponivel', causa: new Error(`Falha ao reivindicar a intervenção: ${error.message}`) };
  }
  if (typeof data !== 'string') {
    return { _tag: 'IntervencaoIndisponivel', causa: new Error('reivindicar_intervencao_venda_manual não devolveu id') };
  }
  return { _tag: 'IntervencaoReivindicada', intervencaoId: data };
}

/** Fecha o rastro de auditoria da intervenção. Depois disto ele é imutável. */
export async function encerrarIntervencao(
  scope: VerifiedOrganizationScope,
  intervencaoId: string,
  resultado: 'confirmada' | 'falhou' | 'ambigua',
  detalhe: string | null,
): Promise<void> {
  const { error } = await supabaseServer.rpc('encerrar_intervencao_venda_manual', {
    p_organizacao_id: scope.organizationId,
    p_intervencao_id: intervencaoId,
    p_resultado: resultado,
    p_detalhe: detalhe,
  });

  if (error) registrarFalhaInterna('pedidos.manual.intervencao.encerrar', error);
}

/**
 * Grava tentativa e intervenção juntas, numa transação só.
 *
 * **Nunca lança.** A falha vira valor porque o chamador tem de reagir a ela: o
 * efeito externo já aconteceu, e responder sucesso aqui seria mentir sobre o
 * que ficou registrado.
 */
export async function finalizarIntervencaoETentativa(
  input: FinalizacaoDeIntervencao,
): Promise<FinalizacaoResultado> {
  const { error } = await supabaseServer.rpc('finalizar_intervencao_e_tentativa', {
    p_organizacao_id: input.scope.organizationId,
    p_intervencao_id: input.intervencaoId,
    p_tentativa_id: input.tentativaId,
    p_resultado_intervencao: input.resultadoIntervencao,
    p_estado_tentativa: input.estadoTentativa,
    p_bling_pedido_id: input.blingPedidoId,
    p_detalhe: input.detalhe,
    p_epoca_esperada: input.epocaEsperada,
  });

  if (error) {
    registrarFalhaInterna('pedidos.manual.intervencao.finalizar', error);
    return { _tag: 'NaoPersistiu', causa: new Error(error.message) };
  }
  return { _tag: 'Persistiu' };
}

/**
 * Encerra uma intervenção que ficou `ambigua`, com a decisão humana registrada
 * (9ª rodada de revisão, B3).
 *
 * `55006` é outro operador tendo resolvido primeiro; `P0002` é não haver
 * ambiguidade pendente; `55P03` é a tentativa ter mudado de dono entre a
 * leitura e a decisão. Os três viram VALOR, porque a rota reage a cada um de
 * um jeito — e nenhum deles é "deu certo".
 */
export async function resolverIntervencaoAmbigua(
  input: ResolucaoDeIntervencaoAmbigua,
): Promise<ResolucaoDeAmbiguidade> {
  const { data, error } = await supabaseServer.rpc('resolver_intervencao_ambigua', {
    p_organizacao_id: input.scope.organizationId,
    p_tentativa_id: input.tentativaId,
    p_ator_id: input.scope.actorId,
    p_decisao: input.decisao,
    p_evidencia: input.evidencia,
    p_epoca_esperada: input.epocaEsperada,
  });

  if (error?.code === '55006') return { _tag: 'AmbiguidadeJaResolvida' };
  if (error?.code === 'P0002') return { _tag: 'SemAmbiguidadePendente' };
  if (error?.code === '55P03') return { _tag: 'ResolucaoSemPosse' };
  if (error) {
    return { _tag: 'ResolucaoIndisponivel', causa: new Error(`Falha ao resolver a ambiguidade: ${error.message}`) };
  }
  if (typeof data !== 'string') {
    return { _tag: 'ResolucaoIndisponivel', causa: new Error('resolver_intervencao_ambigua não devolveu id') };
  }
  return { _tag: 'AmbiguidadeResolvida', resolucaoId: data };
}
