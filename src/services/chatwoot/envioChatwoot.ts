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

/** O que o operador vê de um envio. `sent` exige recibo gravado. */
export type EstadoDoEnvio = 'pendente' | 'enviando' | 'enviado' | 'recusado' | 'desconhecido';

export function estadoDoEnvio(statusDoEvento: string): EstadoDoEnvio {
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
  | { readonly _tag: 'SemVinculo' };

const LinhaDoRegistroSchema = z.object({
  resultado: z.enum(['registrado', 'existente', 'conflito', 'sem_vinculo', 'conversa_inexistente', 'conexao_indisponivel']),
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
  created_at: z.string(),
  outbox_eventos: z.object({
    status: z.string(),
    motivo_bloqueio: z.string().nullable(),
    resolucao: z.string().nullable(),
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
    .select('id, command_id, conteudo, mensagem_id_local, created_at, outbox_eventos!fk_chatwoot_envios_evento(status, motivo_bloqueio, resolucao)')
    .eq('organizacao_id', scope.organizationId)
    .eq('conversa_id_local', conversaId)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw new RegistroDeEnvioIndisponivel();
  return LinhaDoEnvioSchema.array().parse(data ?? []).map((linha) => ({
    id: linha.id,
    commandId: linha.command_id,
    conteudo: linha.conteudo,
    estado: estadoDoEnvio(linha.outbox_eventos.status),
    explicacao: explicarEstado({
      status: linha.outbox_eventos.status,
      motivoBloqueio: linha.outbox_eventos.motivo_bloqueio,
      resolucao: linha.outbox_eventos.resolucao,
    }),
    mensagemIdLocal: linha.mensagem_id_local,
    criadoEm: linha.created_at,
  }));
}
