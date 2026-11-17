import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import { lerMensagensRecentesDoContato } from '@/services/chatwoot/espelhoChatwootSupabase';
import type { ContextoDaResposta } from './gerarResposta';
import { lerTriagemDoCaso } from './leituraDaTriagem';

const CasoSchema = z.object({ ultima_mensagem_em: z.string(), version: z.number().int(), phase: z.string() });

export async function lerContextoDaResposta(
  client: SupabaseClient, scope: VerifiedOrganizationScope, conversaId: string,
): Promise<ContextoDaResposta | null> {
  const triagem = await lerTriagemDoCaso(client, scope, conversaId);
  const caso = triagem._tag === 'Lida' ? triagem.caso : null;
  const execucao = caso?.execucao;
  if (!caso || caso.pendente || execucao?.status !== 'concluida' || !execucao.triagem
    || ['RESOLVED', 'CLOSED', 'CANCELLED'].includes(caso.fase)) return null;
  const casoId = caso.id;

  async function lerCaso() {
    const { data, error } = await client.from('sac_cases').select('ultima_mensagem_em,version,phase')
      .eq('organizacao_id', scope.organizationId).eq('conversa_id_local', conversaId).eq('id', casoId).maybeSingle();
    if (error) throw new Error('Caso indisponível.');
    return data === null ? null : CasoSchema.parse(data);
  }

  const antes = await lerCaso();
  if (!antes || antes.phase !== caso.fase) return null;
  const mensagens = await lerMensagensRecentesDoContato(client, scope, conversaId);
  const [depois, triagemAtual] = await Promise.all([lerCaso(), lerTriagemDoCaso(client, scope, conversaId)]);
  if (!depois || JSON.stringify(antes) !== JSON.stringify(depois)
    || JSON.stringify(triagem) !== JSON.stringify(triagemAtual)) return null;
  return {
    marca: JSON.stringify([caso.id, antes, execucao.criadaEm, execucao.concluidaEm, mensagens]),
    intencao: execucao.triagem.intencao,
    mensagens: mensagens.map((m) => ({ conteudo: m.content ?? '', criadaEm: m.created_at })),
  };
}
