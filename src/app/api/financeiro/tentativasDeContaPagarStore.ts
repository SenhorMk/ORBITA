import { z } from 'zod';

import { registrarFalhaInterna } from '@/lib/observability/falhaInterna';
import { supabaseServer } from '@/lib/supabaseServer';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';

import type {
  DesfechoDaBaixa,
  DesfechoDaTentativa,
  DespesaStorePort,
  GravacaoDeTentativa,
  IntencaoDeContaPagar,
  ReivindicacaoDeBaixa,
  ReivindicacaoDeTentativa,
} from './despesaHandler';

/** A linha que `reivindicar_tentativa_conta_pagar` (migration 73) devolve. */
const linhaDeReivindicacaoSchema = z.object({
  tentativa_id: z.string().min(1).nullable(),
  estado: z.enum(['em_voo', 'nao_enviada', 'confirmada', 'recusada', 'indeterminada']).nullable(),
  epoca: z.number().int().positive().nullable(),
  bling_conta_id: z.string().nullable(),
  titulo_id: z.string().min(1).nullable(),
  contato_bling_id: z.number().int().positive().nullable(),
  desfecho: z.enum(['nova', 'reaberta', 'repetida', 'conflito_de_conteudo', 'pendencia_identica']),
  chave_pendente: z.string().min(1).nullable(),
  // Ausente na resposta de um banco ainda sem a migration 74.
  numero_documento: z.string().nullable().optional(),
});

/**
 * Traduz a linha da RPC no resultado da reivindicação.
 *
 * Qualquer combinação que a migration não produz vira `TentativaIndisponivel`:
 * ler errado aqui decidiria se uma conta a pagar é criada no Bling, então na
 * dúvida o Bling não é chamado.
 *
 * @param linha - O valor cru devolvido pelo PostgREST.
 * @returns O resultado da reivindicação.
 */
export function lerReivindicacao(linha: unknown): ReivindicacaoDeTentativa {
  const lida = linhaDeReivindicacaoSchema.safeParse(linha);
  if (!lida.success) return { _tag: 'TentativaIndisponivel' };
  const r = lida.data;

  switch (r.desfecho) {
    case 'nova':
    case 'reaberta':
      if (r.tentativa_id === null || r.epoca === null || r.estado !== 'em_voo') break;
      return { _tag: 'TentativaPropria', tentativaId: r.tentativa_id, epoca: r.epoca, numeroDocumento: r.numero_documento ?? null };
    case 'repetida':
      if (r.tentativa_id === null || r.estado === null || r.estado === 'nao_enviada') break;
      return {
        _tag: 'TentativaRepetida',
        tentativaId: r.tentativa_id,
        estado: r.estado,
        blingContaId: r.bling_conta_id,
        tituloId: r.titulo_id,
        contatoBlingId: r.contato_bling_id,
      };
    case 'conflito_de_conteudo':
      return { _tag: 'ConflitoDeConteudo' };
    case 'pendencia_identica':
      // Sem a chave pendente, a pendência foi resolvida entre o 23505 e a
      // leitura. Não dá para apontar nada: o cliente tenta de novo.
      if (r.chave_pendente === null) break;
      return { _tag: 'PendenciaIdentica', chavePendente: r.chave_pendente };
  }
  return { _tag: 'TentativaIndisponivel' };
}

async function reivindicarTentativa(
  scope: VerifiedOrganizationScope,
  intencao: IntencaoDeContaPagar,
): Promise<ReivindicacaoDeTentativa> {
  const { data, error } = await supabaseServer.rpc('reivindicar_tentativa_conta_pagar', {
    p_organizacao_id: scope.organizationId,
    p_chave: intencao.chave,
    p_digest: intencao.digest,
    p_valor: intencao.valor,
    p_data_vencimento: intencao.dataVencimento,
    p_data_emissao: intencao.dataEmissao,
    p_contato_bling_id: intencao.contatoBlingId,
    p_numero_documento: intencao.numeroDocumento,
    p_quitacao_solicitada: intencao.quitacaoSolicitada,
  });

  // Toda falha, inclusive tabela ou função ausente (`42883`/`42P01` num banco
  // sem a migration 73), é falha FECHADA: sem a intenção gravada, nada vai ao
  // Bling.
  if (error) {
    registrarFalhaInterna('financeiro.despesa.tentativa.reivindicar', error);
    return { _tag: 'TentativaIndisponivel' };
  }

  const reivindicacao = lerReivindicacao(Array.isArray(data) ? data[0] : data);
  if (reivindicacao._tag === 'TentativaIndisponivel') {
    registrarFalhaInterna('financeiro.despesa.tentativa.reivindicar.linha', new Error('linha inesperada'));
  }
  return reivindicacao;
}

/**
 * Grava o desfecho por compare-and-set: só muda a linha que ainda está
 * `em_voo` na época de quem reivindicou. A organização filtra a escrita
 * porque o service_role ignora RLS.
 */
async function concluirTentativa(
  scope: VerifiedOrganizationScope,
  tentativa: { readonly tentativaId: string; readonly epoca: number },
  desfecho: DesfechoDaTentativa,
): Promise<GravacaoDeTentativa> {
  const campos = desfecho.estado === 'confirmada'
    ? { estado: 'confirmada', bling_conta_id: desfecho.blingContaId, contato_bling_id: desfecho.contatoBlingId }
    : {
        estado: desfecho.estado,
        motivo: desfecho.motivo,
        ...(desfecho.contatoBlingId !== null ? { contato_bling_id: desfecho.contatoBlingId } : {}),
      };

  const { data, error } = await supabaseServer
    .from('tentativas_conta_pagar')
    .update(campos)
    .eq('organizacao_id', scope.organizationId)
    .eq('id', tentativa.tentativaId)
    .eq('estado', 'em_voo')
    .eq('epoca', tentativa.epoca)
    .select('id');

  if (error) {
    registrarFalhaInterna('financeiro.despesa.tentativa.concluir', error);
    return 'NaoGravado';
  }
  return Array.isArray(data) && data.length === 1 ? 'Gravado' : 'NaoGravado';
}

async function vincularTitulo(
  scope: VerifiedOrganizationScope,
  tentativaId: string,
  tituloId: string,
): Promise<GravacaoDeTentativa> {
  const { data, error } = await supabaseServer
    .from('tentativas_conta_pagar')
    .update({ titulo_id: tituloId })
    .eq('organizacao_id', scope.organizationId)
    .eq('id', tentativaId)
    .eq('estado', 'confirmada')
    .is('titulo_id', null)
    .select('id');

  if (error) {
    registrarFalhaInterna('financeiro.despesa.tentativa.vincular', error);
    return 'NaoGravado';
  }
  return Array.isArray(data) && data.length === 1 ? 'Gravado' : 'NaoGravado';
}

const linhaDeBaixaSchema = z.object({
  baixa_id: z.string().min(1),
  estado: z.enum(['em_voo', 'nao_enviada', 'confirmada', 'recusada', 'indeterminada']),
  epoca: z.number().int().positive(),
  desfecho: z.enum(['nova', 'reaberta', 'repetida']),
});

/**
 * Traduz a linha de `reivindicar_baixa_conta_pagar` (migration 74). Qualquer
 * combinação inesperada é indisponível: na dúvida, a quitação não sai.
 *
 * @param linha - O valor cru devolvido pelo PostgREST.
 * @returns O resultado da reivindicação da baixa.
 */
export function lerReivindicacaoDeBaixa(linha: unknown): ReivindicacaoDeBaixa {
  const lida = linhaDeBaixaSchema.safeParse(linha);
  if (!lida.success) return { _tag: 'BaixaIndisponivel' };
  const { desfecho, estado, baixa_id: baixaId, epoca } = lida.data;
  if (desfecho !== 'repetida') {
    return estado === 'em_voo' ? { _tag: 'BaixaPropria', baixaId, epoca } : { _tag: 'BaixaIndisponivel' };
  }
  return estado === 'nao_enviada' ? { _tag: 'BaixaIndisponivel' } : { _tag: 'BaixaRepetida', estado };
}

async function reivindicarBaixa(
  scope: VerifiedOrganizationScope,
  baixa: { readonly tentativaId: string; readonly blingContaId: string; readonly dataBaixa: string },
): Promise<ReivindicacaoDeBaixa> {
  const { data, error } = await supabaseServer.rpc('reivindicar_baixa_conta_pagar', {
    p_organizacao_id: scope.organizationId,
    p_tentativa_id: baixa.tentativaId,
    p_bling_conta_id: baixa.blingContaId,
    p_data_baixa: baixa.dataBaixa,
  });
  if (error) {
    registrarFalhaInterna('financeiro.baixa.reivindicar', error);
    return { _tag: 'BaixaIndisponivel' };
  }
  return lerReivindicacaoDeBaixa(Array.isArray(data) ? data[0] : data);
}

async function concluirBaixa(
  scope: VerifiedOrganizationScope,
  baixa: { readonly baixaId: string; readonly epoca: number },
  desfecho: DesfechoDaBaixa,
): Promise<GravacaoDeTentativa> {
  const campos = desfecho.estado === 'confirmada'
    ? { estado: 'confirmada', bordero_id: desfecho.borderoId }
    : { estado: desfecho.estado, motivo: desfecho.motivo };
  const { data, error } = await supabaseServer
    .from('baixas_conta_pagar')
    .update(campos)
    .eq('organizacao_id', scope.organizationId)
    .eq('id', baixa.baixaId)
    .eq('estado', 'em_voo')
    .eq('epoca', baixa.epoca)
    .select('id');
  if (error) {
    registrarFalhaInterna('financeiro.baixa.concluir', error);
    return 'NaoGravado';
  }
  return Array.isArray(data) && data.length === 1 ? 'Gravado' : 'NaoGravado';
}

/** As operações de tentativa que `DespesaStorePort` exige, sobre o Supabase. */
export const tentativasDeContaPagarStore: Pick<
  DespesaStorePort,
  'reivindicarTentativa' | 'concluirTentativa' | 'vincularTitulo' | 'reivindicarBaixa' | 'concluirBaixa'
> = {
  reivindicarTentativa,
  concluirTentativa,
  vincularTitulo,
  reivindicarBaixa,
  concluirBaixa,
};
