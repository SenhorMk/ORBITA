/**
 * O envio de uma resposta pelo cockpit (MSG-008), do lado da requisição.
 *
 * Enviar é **registrar uma intenção**, não chamar o Chatwoot: a RPC
 * `registrar_envio_chatwoot` grava a intenção, o evento da outbox e a
 * auditoria numa transação, e quem despacha é o worker
 * (`consumidorEnvioChatwoot.ts`). A identidade é o `commandId` gerado pelo
 * navegador antes da rede e reutilizado em qualquer repetição: o mesmo comando
 * com o mesmo conteúdo devolve a mesma intenção; com outro conteúdo, conflito.
 *
 * A organização e o autor vêm do escopo verificado; a conexão e o id remoto,
 * da conversa local, no banco. Nada aqui aceita id remoto do navegador.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

import type { VerifiedOrganizationScope } from '../../lib/verifiedOrganizationScope';
import { desfechoVisivel, explicarEstado } from '../outbox/desfechoDoEfeito';

/**
 * O que o operador vê de um envio. `sent` exige recibo gravado; `invalidado` é
 * o envio que o controle do atendimento tirou da fila antes da rede (MSG-009).
 */
export type EstadoDoEnvio = 'pendente' | 'enviando' | 'enviado' | 'recusado' | 'desconhecido' | 'invalidado';

export function estadoDoEnvio(statusDoEvento: string, invalidado = false): EstadoDoEnvio {
  if (invalidado) return 'invalidado';
  if (statusDoEvento === 'in_flight') return 'enviando';
  switch (desfechoVisivel(statusDoEvento)) {
    case 'confirmado': return 'enviado';
    case 'recusado': return 'recusado';
    case 'desconhecido': return 'desconhecido';
    default: return 'pendente';
  }
}

export interface EnvioRegistrado {
  readonly id: string;
  readonly commandId: string;
  readonly estado: EstadoDoEnvio;
  readonly duplicado: boolean;
}

export type ResultadoDoRegistro =
  | { readonly _tag: 'Registrado'; readonly envio: EnvioRegistrado }
  | { readonly _tag: 'Conflito' }
  | { readonly _tag: 'ConversaNaoEncontrada' }
  | { readonly _tag: 'ConexaoIndisponivel' }
  | { readonly _tag: 'SemVinculo' }
  | { readonly _tag: 'OutroResponsavel' };

const LinhaDoRegistroSchema = z.object({
  resultado: z.enum([
    'registrado', 'existente', 'conflito', 'sem_vinculo', 'conversa_inexistente', 'conexao_indisponivel', 'outro_responsavel',
  ]),
  envio_id: z.string().nullable(),
  evento_id: z.string().nullable(),
  status: z.string().nullable(),
});

export class RegistroDeEnvioIndisponivel extends Error {
  constructor() {
    super('Não foi possível registrar o envio.');
    this.name = 'RegistroDeEnvioIndisponivel';
  }
}

export async function registrarEnvio(
  supabase: SupabaseClient,
  scope: VerifiedOrganizationScope,
  comando: { readonly conversaId: string; readonly commandId: string; readonly conteudo: string },
): Promise<ResultadoDoRegistro> {
  const { data, error } = await supabase.rpc('registrar_envio_chatwoot', {
    p_organizacao_id: scope.organizationId,
    p_ator_id: scope.actorId,
    p_conversa_id_local: comando.conversaId,
    p_command_id: comando.commandId,
    p_conteudo: comando.conteudo,
  });
  if (error) throw new RegistroDeEnvioIndisponivel();
  const linha = LinhaDoRegistroSchema.safeParse(Array.isArray(data) ? data[0] : data);
  if (!linha.success) throw new RegistroDeEnvioIndisponivel();

  const { resultado, envio_id: envioId, status } = linha.data;
  switch (resultado) {
    case 'conflito': return { _tag: 'Conflito' };
    case 'conversa_inexistente': return { _tag: 'ConversaNaoEncontrada' };
    case 'conexao_indisponivel': return { _tag: 'ConexaoIndisponivel' };
    case 'sem_vinculo': return { _tag: 'SemVinculo' };
    case 'outro_responsavel': return { _tag: 'OutroResponsavel' };
    case 'registrado':
    case 'existente':
      if (envioId === null || status === null) throw new RegistroDeEnvioIndisponivel();
      return {
        _tag: 'Registrado',
        envio: { id: envioId, commandId: comando.commandId, estado: estadoDoEnvio(status), duplicado: resultado === 'existente' },
      };
  }
}

/** Um envio da conversa como a tela o mostra. Sem payload, recibo ou evidência. */
export interface EnvioDaConversa {
  readonly id: string;
  readonly commandId: string;
  readonly conteudo: string;
  readonly estado: EstadoDoEnvio;
  readonly explicacao: string;
  readonly mensagemIdLocal: string | null;
  readonly criadoEm: string;
}

const LinhaDoEnvioSchema = z.object({
  id: z.string(),
  command_id: z.string(),
  conteudo: z.string(),
  mensagem_id_local: z.string().nullable(),
  invalidado_em: z.string().nullable().optional(),
  created_at: z.string(),
  outbox_eventos: z.object({
    status: z.string(),
    motivo_bloqueio: z.string().nullable(),
    resolucao: z.string().nullable(),
    last_error: z.string().nullable(),
  }),
});

/**
 * Os envios mais recentes da conversa, da organização verificada. O
 * `service_role` ignora RLS: o filtro por organização é que isola.
 */
export async function listarEnviosDaConversa(
  supabase: SupabaseClient,
  scope: VerifiedOrganizationScope,
  conversaId: string,
): Promise<readonly EnvioDaConversa[]> {
  const { data, error } = await supabase
    .from('chatwoot_envios')
    .select('id, command_id, conteudo, mensagem_id_local, invalidado_em, created_at, outbox_eventos!fk_chatwoot_envios_evento(status, motivo_bloqueio, resolucao, last_error)')
    .eq('organizacao_id', scope.organizationId)
    .eq('conversa_id_local', conversaId)
    // Notas privadas não são respostas à cliente (MSG-009).
    .eq('privada', false)
    .order('created_at', { ascending: false })
    .limit(50);
  const linhas = LinhaDoEnvioSchema.array().safeParse(data ?? []);
  if (error || !linhas.success) throw new RegistroDeEnvioIndisponivel();
  return linhas.data.map((linha) => {
    const outbox = linha.outbox_eventos;
    const pausada = outbox.status === 'dead_letter' && outbox.last_error === 'autorresposta_invalidada';
    const explicacao = explicarEstado({
      status: outbox.status,
      motivoBloqueio: outbox.motivo_bloqueio,
      resolucao: outbox.resolucao,
    });
    return {
      id: linha.id,
      commandId: linha.command_id,
      conteudo: linha.conteudo,
      estado: estadoDoEnvio(outbox.status, pausada || Boolean(linha.invalidado_em)),
      explicacao: pausada
        ? 'Resposta automática invalidada pela política antes do envio.'
        : linha.invalidado_em
          ? 'Não enviada: o atendimento mudou de responsável antes do envio.'
          : explicacao,
      mensagemIdLocal: linha.mensagem_id_local,
      criadoEm: linha.created_at,
    };
  });
}

/**
 * O que o envio prova para o corte do assistente. Só `sent` (que o banco só
 * aceita com `confirmacao`) prova que a resposta chegou. Registrado e ainda
 * na fila (`pending`, `processing`, `failed_transient`, `in_flight`), morto
 * (`dead_letter`, com ou sem invalidação de política) e de resultado
 * desconhecido (`unknown`, mesmo depois de resolvido) não provam: tratar
 * qualquer um deles como resposta faria a pergunta parecer atendida sem o
 * cliente ter recebido nada. Invalidado por mudança de responsável não saiu.
 */
export type ProvaDoEnvio = 'confirmado' | 'registrado' | 'nao_entregue' | 'desconhecido';

export function provaDoEnvio(envio: { readonly status: string; readonly invalidadoEm: string | null }): ProvaDoEnvio {
  if (envio.invalidadoEm !== null) return 'nao_entregue';
  switch (envio.status) {
    case 'sent': return 'confirmado';
    case 'pending': case 'processing': case 'failed_transient': case 'in_flight': return 'registrado';
    case 'dead_letter': return 'nao_entregue';
    default: return 'desconhecido';
  }
}

const EnvioParaCorteSchema = z.object({
  created_at: z.string().datetime({ offset: true }),
  invalidado_em: z.string().nullable(),
  outbox_eventos: z.object({ status: z.string() }),
});
/** Basta para achar o último confirmado atrás de alguns registrados ou mortos; se não achar, o corte fica mais cedo (conservador). */
const ENVIOS_PARA_O_CORTE = 20;

/**
 * Instante do último envio público **confirmado** na conversa (IA ou
 * atendente), ou `null`. A decisão é feita aqui, sobre o estado lido da
 * outbox, e não por filtro do PostgREST. Organização, conexão e conversa vão
 * explícitas no filtro (service role); só instante e estado saem do banco.
 */
export async function lerUltimoEnvioConfirmadoDaConversa(
  supabase: SupabaseClient,
  escopo: { readonly organizacaoId: string; readonly conexaoId: string },
  conversaId: string,
): Promise<string | null> {
  const uuid = z.string().uuid();
  if (![escopo.organizacaoId, escopo.conexaoId, conversaId].every((v) => uuid.safeParse(v).success)) throw new RegistroDeEnvioIndisponivel();
  const { data, error } = await supabase
    .from('chatwoot_envios')
    .select('created_at, invalidado_em, outbox_eventos!fk_chatwoot_envios_evento(status)')
    .eq('organizacao_id', escopo.organizacaoId)
    .eq('conexao_id', escopo.conexaoId)
    .eq('conversa_id_local', conversaId)
    .eq('privada', false)
    .order('created_at', { ascending: false })
    .limit(ENVIOS_PARA_O_CORTE);
  const linhas = EnvioParaCorteSchema.array().max(ENVIOS_PARA_O_CORTE).safeParse(data ?? []);
  if (error || !linhas.success) throw new RegistroDeEnvioIndisponivel();
  const confirmado = linhas.data.find((l) => provaDoEnvio({ status: l.outbox_eventos.status, invalidadoEm: l.invalidado_em }) === 'confirmado');
  return confirmado?.created_at ?? null;
}
