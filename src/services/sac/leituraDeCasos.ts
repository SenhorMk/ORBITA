import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

import type { CasoSac, EventoRecebido } from '@/lib/integrations/contratoDaMensageria';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';

/**
 * O que o operador vê do consumo da inbox (MSG-006). Só leitura, com o cliente
 * `service_role`: a RLS não protege aqui, então toda consulta filtra a organização
 * do escopo verificado. O payload e o conteúdo das mensagens não são selecionados.
 */

const EventoLidoSchema = z.object({
  id: z.string().uuid(),
  event_type: z.string(),
  status: z.enum(['received', 'processing', 'processed', 'failed', 'ignored']),
  disposicao: z.string().nullable(),
  last_error: z.string().nullable(),
  attempts: z.number().int(),
  caso_id: z.string().uuid().nullable(),
  created_at: z.string(),
  processed_at: z.string().nullable(),
});

const CasoLidoSchema = z.object({
  id: z.string().uuid(),
  phase: z.string(),
  version: z.number().int(),
  conversa_id_local: z.string().uuid(),
  created_at: z.string(),
  ultima_mensagem_em: z.string(),
});

const LIMITE_DA_LEITURA = 30;
/** Linhas antigas guardam texto livre em `last_error`; só código passa. */
const CODIGO_TECNICO = /^[a-z0-9_]{1,64}$/;

function estadoDoEvento(linha: z.infer<typeof EventoLidoSchema>): EventoRecebido['estado'] {
  switch (linha.status) {
    case 'received': return 'recebida';
    case 'processing': return 'processando';
    case 'processed': return 'processada';
    case 'ignored': return 'ignorada';
    case 'failed': return linha.disposicao === 'falha_definitiva' ? 'falha_definitiva' : 'falha_com_retentativa';
  }
}

export async function listarEventosRecebidos(supabase: SupabaseClient, scope: VerifiedOrganizationScope): Promise<EventoRecebido[]> {
  const { data, error } = await supabase
    .from('inbox_eventos_chatwoot')
    .select('id, event_type, status, disposicao, last_error, attempts, caso_id, created_at, processed_at')
    .eq('organizacao_id', scope.organizationId)
    .order('created_at', { ascending: false })
    .limit(LIMITE_DA_LEITURA);
  if (error) throw new Error(`Falha ao consultar a inbox (${error.code ?? 'sem-codigo'}).`);
  return EventoLidoSchema.array().parse(data ?? []).map((linha) => ({
    id: linha.id,
    tipo: linha.event_type,
    estado: estadoDoEvento(linha),
    disposicao: linha.disposicao,
    motivo: linha.last_error === null ? null : CODIGO_TECNICO.test(linha.last_error) ? linha.last_error : 'erro_legado',
    tentativas: linha.attempts,
    casoId: linha.caso_id,
    recebidaEm: linha.created_at,
    processadaEm: linha.processed_at,
  }));
}

export async function listarCasos(supabase: SupabaseClient, scope: VerifiedOrganizationScope): Promise<CasoSac[]> {
  const { data, error } = await supabase
    .from('sac_cases')
    .select('id, phase, version, conversa_id_local, created_at, ultima_mensagem_em')
    .eq('organizacao_id', scope.organizationId)
    .order('updated_at', { ascending: false })
    .limit(LIMITE_DA_LEITURA);
  if (error) throw new Error(`Falha ao consultar os casos (${error.code ?? 'sem-codigo'}).`);
  return CasoLidoSchema.array().parse(data ?? []).map((linha) => ({
    id: linha.id,
    fase: linha.phase,
    versao: linha.version,
    conversaIdLocal: linha.conversa_id_local,
    abertoEm: linha.created_at,
    ultimaMensagemEm: linha.ultima_mensagem_em,
  }));
}
