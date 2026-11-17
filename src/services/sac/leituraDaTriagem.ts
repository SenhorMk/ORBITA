/**
 * O que o cockpit vê da triagem do caso atual da conversa (MSG-013). Só
 * leitura, pela função da migration 94, com a organização do escopo
 * verificado. O resultado gravado passa de novo pelo schema: linha que não o
 * cumpre é indisponibilidade, nunca triagem.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

import { MotivoSemTriagemSchema, TriagemV1Schema, type RespostaDaTriagem } from '@/lib/integrations/contratoDaTriagem';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';

export class TriagemIndisponivel extends Error {
  constructor() {
    super('Não foi possível ler a triagem do caso.');
    this.name = 'TriagemIndisponivel';
  }
}

const LeituraSchema = z.discriminatedUnion('resultado', [
  z.object({ resultado: z.literal('conversa_inexistente') }),
  z.object({ resultado: z.literal('sem_caso') }),
  z.object({
    resultado: z.literal('caso'),
    caso_id: z.string().uuid(),
    fase: z.string(),
    pendente: z.boolean(),
    execucao: z.object({
      status: z.enum(['em_andamento', 'concluida', 'handoff', 'falha', 'obsoleta']),
      motivo: MotivoSemTriagemSchema.nullable(),
      resultado: TriagemV1Schema.nullable(),
      provedor: z.string(),
      modelo: z.string(),
      versao_schema: z.number().int(),
      criada_em: z.string(),
      concluida_em: z.string().nullable(),
    }).nullable(),
  }),
]);

export type LeituraDaTriagem =
  | { readonly _tag: 'Lida'; readonly caso: RespostaDaTriagem['caso'] }
  | { readonly _tag: 'ConversaNaoEncontrada' };

export async function lerTriagemDoCaso(
  supabase: SupabaseClient,
  scope: VerifiedOrganizationScope,
  conversaId: string,
): Promise<LeituraDaTriagem> {
  const { data, error } = await supabase.rpc('ler_triagem_do_caso_sac', {
    p_organizacao_id: scope.organizationId,
    p_conversa_id_local: conversaId,
  });
  if (error) throw new TriagemIndisponivel();
  const lido = LeituraSchema.safeParse(data);
  if (!lido.success) throw new TriagemIndisponivel();

  const linha = lido.data;
  if (linha.resultado === 'conversa_inexistente') return { _tag: 'ConversaNaoEncontrada' };
  if (linha.resultado === 'sem_caso') return { _tag: 'Lida', caso: null };
  const e = linha.execucao;
  return {
    _tag: 'Lida',
    caso: {
      id: linha.caso_id,
      fase: linha.fase,
      pendente: linha.pendente,
      execucao: e === null ? null : {
        status: e.status,
        motivo: e.motivo,
        // Resultado obsoleto não é mostrado como atual: o caso andou depois dele.
        triagem: e.status === 'concluida' ? e.resultado : null,
        provedor: e.provedor,
        modelo: e.modelo,
        criadaEm: e.criada_em,
        concluidaEm: e.concluida_em,
      },
    },
  };
}
