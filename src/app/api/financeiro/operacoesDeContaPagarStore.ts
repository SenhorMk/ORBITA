import { z } from 'zod';

import { metodoDoReciboSchema, motivoDeRevisaoSchema } from '@/lib/config/operacaoFinanceiraContract';
import { registrarFalhaInterna } from '@/lib/observability/falhaInterna';
import { supabaseServer } from '@/lib/supabaseServer';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';

import type { GravacaoDeTentativa } from './despesaHandler';
import type { OperacaoRegistrada, OperacoesStorePort, RegistroDeReconciliacao } from './reconciliacaoDaOperacao';

const estado = z.enum(['em_voo', 'nao_enviada', 'confirmada', 'recusada', 'indeterminada']);

const tentativaSchema = z.object({
  id: z.string().min(1),
  chave: z.string().min(1),
  estado,
  valor: z.coerce.number(),
  data_vencimento: z.string(),
  data_emissao: z.string(),
  contato_bling_id: z.number().int().positive().nullable(),
  numero_documento: z.string().nullable(),
  quitacao_solicitada: z.boolean(),
  bling_conta_id: z.string().nullable(),
  titulo_id: z.string().nullable(),
});

const baixaSchema = z.object({
  id: z.string().min(1),
  tentativa_id: z.string().min(1),
  estado,
  bling_conta_id: z.string(),
  data_baixa: z.string(),
});

const tituloSchema = z.object({ id: z.string().min(1), situacao: z.string() });

const reciboSchema = z.object({
  tentativa_id: z.string().min(1),
  alvo: z.enum(['criacao', 'baixa']),
  metodo: metodoDoReciboSchema,
  resultado: z.enum(['confirmada', 'ja_confirmada', 'revisao_manual', 'divergente']),
  motivo: motivoDeRevisaoSchema.nullable(),
  created_at: z.string(),
});

const COLUNAS_DA_TENTATIVA =
  'id, chave, estado, valor, data_vencimento, data_emissao, contato_bling_id, numero_documento, quitacao_solicitada, bling_conta_id, titulo_id';

/**
 * Monta as operações a partir das quatro tabelas. Leituras simples, sem
 * join do PostgREST: um join sobre relação recém-criada derruba a consulta
 * inteira quando o cache de esquema está atrasado.
 */
async function montar(
  scope: VerifiedOrganizationScope,
  tentativas: readonly z.infer<typeof tentativaSchema>[],
): Promise<readonly OperacaoRegistrada[] | null> {
  if (tentativas.length === 0) return [];
  const ids = tentativas.map((t) => t.id);
  const idsDeTitulo = tentativas.flatMap((t) => (t.titulo_id === null ? [] : [t.titulo_id]));
  const [baixas, recibos, titulos] = await Promise.all([
    supabaseServer.from('baixas_conta_pagar').select('id, tentativa_id, estado, bling_conta_id, data_baixa')
      .eq('organizacao_id', scope.organizationId).in('tentativa_id', ids),
    supabaseServer.from('reconciliacoes_conta_pagar').select('tentativa_id, alvo, metodo, resultado, motivo, created_at')
      .eq('organizacao_id', scope.organizationId).in('tentativa_id', ids).order('created_at', { ascending: false }),
    idsDeTitulo.length === 0
      ? Promise.resolve({ data: [], error: null })
      : supabaseServer.from('titulos_financeiros').select('id, situacao')
          .eq('organizacao_id', scope.organizationId).in('id', idsDeTitulo),
  ]);
  if (baixas.error || recibos.error || titulos.error) {
    registrarFalhaInterna('financeiro.operacoes.ler', baixas.error ?? recibos.error ?? titulos.error);
    return null;
  }
  const baixasLidas = z.array(baixaSchema).safeParse(baixas.data);
  const recibosLidos = z.array(reciboSchema).safeParse(recibos.data);
  const titulosLidos = z.array(tituloSchema).safeParse(titulos.data);
  if (!baixasLidas.success || !recibosLidos.success || !titulosLidos.success) return null;

  return tentativas.map((t) => {
    const baixa = baixasLidas.data.find((b) => b.tentativa_id === t.id) ?? null;
    const recibo = recibosLidos.data.find((r) => r.tentativa_id === t.id) ?? null;
    return {
      tentativaId: t.id,
      ref: t.chave,
      estado: t.estado,
      valor: t.valor,
      dataVencimento: t.data_vencimento,
      dataEmissao: t.data_emissao,
      contatoBlingId: t.contato_bling_id,
      numeroDocumento: t.numero_documento,
      quitacaoSolicitada: t.quitacao_solicitada,
      blingContaId: t.bling_conta_id,
      tituloId: t.titulo_id,
      tituloSituacao: titulosLidos.data.find((titulo) => titulo.id === t.titulo_id)?.situacao ?? null,
      baixa: baixa
        ? { id: baixa.id, estado: baixa.estado, blingContaId: baixa.bling_conta_id, dataBaixa: baixa.data_baixa }
        : null,
      ultimaReconciliacao: recibo
        ? { alvo: recibo.alvo, metodo: recibo.metodo, resultado: recibo.resultado, motivo: recibo.motivo, em: recibo.created_at }
        : null,
    };
  });
}

const lerOperacao: OperacoesStorePort['lerOperacao'] = async (scope, ref) => {
  const { data, error } = await supabaseServer.from('tentativas_conta_pagar').select(COLUNAS_DA_TENTATIVA)
    .eq('organizacao_id', scope.organizationId).eq('chave', ref).maybeSingle();
  if (error) {
    registrarFalhaInterna('financeiro.operacoes.ler', error);
    return { _tag: 'Indisponivel' };
  }
  if (data === null) return { _tag: 'NaoEncontrada' };
  const tentativa = tentativaSchema.safeParse(data);
  if (!tentativa.success) return { _tag: 'Indisponivel' };
  const operacoes = await montar(scope, [tentativa.data]);
  const [operacao] = operacoes ?? [];
  return operacao ? { _tag: 'Encontrada', operacao } : { _tag: 'Indisponivel' };
};

/** Quantas pendências a tela recebe; `total` diz quantas existem. */
const LIMITE_DA_LISTA = 100;

const pendenciaListadaSchema = z.object({ tentativa_id: z.string().min(1), total: z.coerce.number().int().nonnegative() });

const listarPendentes: OperacoesStorePort['listarPendentes'] = async (scope) => {
  // A pendência é decidida no banco, sobre todas as operações da organização:
  // nenhuma janela de "mais recentes" esconde uma pendência antiga.
  const listadas = await supabaseServer.rpc('listar_pendencias_conta_pagar', {
    p_organizacao_id: scope.organizationId,
    p_limite: LIMITE_DA_LISTA,
  });
  if (listadas.error) {
    registrarFalhaInterna('financeiro.operacoes.listar', listadas.error);
    return { _tag: 'Indisponivel' };
  }
  const linhas = z.array(pendenciaListadaSchema).safeParse(listadas.data);
  if (!linhas.success) return { _tag: 'Indisponivel' };
  if (linhas.data.length === 0) return { _tag: 'Listadas', operacoes: [], total: 0 };

  const ids = linhas.data.map((l) => l.tentativa_id);
  const { data, error } = await supabaseServer.from('tentativas_conta_pagar').select(COLUNAS_DA_TENTATIVA)
    .eq('organizacao_id', scope.organizationId).in('id', ids);
  if (error) {
    registrarFalhaInterna('financeiro.operacoes.listar', error);
    return { _tag: 'Indisponivel' };
  }
  const tentativas = z.array(tentativaSchema).safeParse(data);
  if (!tentativas.success) return { _tag: 'Indisponivel' };
  const porId = new Map(tentativas.data.map((t) => [t.id, t]));
  const operacoes = await montar(scope, ids.flatMap((id) => porId.get(id) ?? []));
  // Uma operação listada pelo banco é mostrada mesmo se esta camada discordar:
  // nunca some em silêncio.
  return operacoes === null
    ? { _tag: 'Indisponivel' }
    : { _tag: 'Listadas', operacoes, total: Math.max(linhas.data[0]?.total ?? 0, operacoes.length) };
};

const linhaDoRegistroSchema = z.object({
  resultado: z.enum(['confirmada', 'ja_confirmada', 'revisao_manual', 'divergente']),
  motivo: motivoDeRevisaoSchema.nullable(),
});

async function registrarReconciliacao(scope: VerifiedOrganizationScope, registro: RegistroDeReconciliacao) {
  const { prova } = registro;
  const conta = prova._tag === 'Comprovada' ? prova.conta : null;
  const { data, error } = await supabaseServer.rpc('registrar_reconciliacao_conta_pagar', {
    p_organizacao_id: scope.organizationId,
    p_chave: registro.ref,
    p_alvo: registro.alvo,
    // O ator vem do escopo verificado, nunca da requisição.
    p_ator_id: scope.actorId,
    p_correlation_id: registro.correlationId,
    p_metodo: registro.metodo,
    p_resultado: prova._tag === 'Comprovada' ? 'confirmada' : 'revisao_manual',
    p_motivo: prova._tag === 'RevisaoManual' ? prova.motivo : null,
    p_bling_conta_id: conta?.id ?? null,
    p_bordero_id: prova._tag === 'Comprovada' ? prova.borderoId : null,
    p_situacao_remota: conta?.situacao ?? null,
    p_candidatos: prova.candidatos,
  });
  if (error) {
    registrarFalhaInterna('financeiro.reconciliacao.registrar', error);
    return { _tag: 'Indisponivel' } as const;
  }
  const linha = linhaDoRegistroSchema.safeParse(Array.isArray(data) ? data[0] : data);
  if (!linha.success) return { _tag: 'Indisponivel' } as const;
  return { _tag: 'Registrada', resultado: linha.data.resultado, motivo: linha.data.motivo } as const;
}

async function categoriaLocalPorBlingId(scope: VerifiedOrganizationScope, categoriaBlingId: number): Promise<string | null> {
  const { data } = await supabaseServer.from('categorias_financeiras').select('id')
    .eq('organizacao_id', scope.organizationId).eq('bling_id', categoriaBlingId).maybeSingle();
  const lida = z.object({ id: z.string() }).safeParse(data);
  return lida.success ? lida.data.id : null;
}

async function marcarTituloPago(scope: VerifiedOrganizationScope, tituloId: string): Promise<GravacaoDeTentativa> {
  const { data, error } = await supabaseServer.from('titulos_financeiros').update({ situacao: 'pago' })
    .eq('organizacao_id', scope.organizationId).eq('id', tituloId).eq('situacao', 'aberto').select('id');
  if (error) {
    registrarFalhaInterna('financeiro.reconciliacao.titulo_pago', error);
    return 'NaoGravado';
  }
  return Array.isArray(data) && data.length === 1 ? 'Gravado' : 'NaoGravado';
}

/** `OperacoesStorePort` sobre o Supabase. Toda leitura e escrita filtra a organização verificada. */
export const operacoesDeContaPagarStore: OperacoesStorePort = {
  lerOperacao,
  listarPendentes,
  registrarReconciliacao,
  categoriaLocalPorBlingId,
  marcarTituloPago,
};
