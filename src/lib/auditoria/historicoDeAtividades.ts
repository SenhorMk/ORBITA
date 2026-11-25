import { z } from 'zod';
import { getAuditEventDefinition } from '@/lib/observability/auditEventCatalog';
import { papelMembroSchema, type PapelMembro } from '@/lib/organizationContext';
import type { IdentidadeDeExibicao } from '@/lib/organizacao/identidadeDoMembro';

/** O evento como a trilha o guarda; só os campos que o histórico lê. */
export interface EventoDaTrilha {
  readonly id: string;
  readonly actorId: string | null;
  readonly acao: string;
  readonly recurso: string;
  readonly recursoId: string | null;
  readonly correlationId: string | null;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: string;
}

/**
 * O histórico de atividades da organização: cada evento da trilha de auditoria
 * com **quem** o fez, dito de um jeito que uma pessoa confere.
 *
 * Três autores possíveis, e nenhum se confunde com outro:
 * - `pessoa`: um usuário autenticado. Vem com o nome do cadastro e o papel que
 *   ele tem **hoje** na organização; `papel: null` é quem já saiu dela, e
 *   continua identificado, porque a trilha não esquece quem fez.
 * - `bot`: a resposta automática da IA. O evento não tem ator humano e a
 *   metadata gravada pelo banco diz `origem: 'ia'` (migration 95).
 * - `sistema`: o resto sem ator humano (webhook, worker, triagem automática).
 *
 * Ação feita pelo assistente administrativo continua sendo da pessoa que a
 * confirmou; `viaAssistente` só registra o caminho.
 *
 * IP, navegador e metadata ficam no banco: a tela não precisa deles para
 * dizer quem fez o quê, e o `correlationId` basta para chegar ao resto.
 */

export const origemDoNomeSchema = z.enum(['cadastro', 'ausente', 'indisponivel']);

export const autorDaAtividadeSchema = z.discriminatedUnion('tipo', [
  z.object({
    tipo: z.literal('pessoa'),
    userId: z.string(),
    papel: papelMembroSchema.nullable(),
    nome_exibicao: z.string().nullable(),
    origem_do_nome: origemDoNomeSchema,
  }),
  z.object({ tipo: z.literal('bot') }),
  z.object({ tipo: z.literal('sistema') }),
]);
export type AutorDaAtividade = z.infer<typeof autorDaAtividadeSchema>;

export const atividadeSchema = z.object({
  id: z.string(),
  acao: z.string(),
  descricao: z.string(),
  recurso: z.string(),
  recursoId: z.string().nullable(),
  correlationId: z.string().nullable(),
  createdAt: z.string(),
  autor: autorDaAtividadeSchema,
  viaAssistente: z.boolean(),
  /** Severidade do catálogo: `critical` pede conferência de alguém. */
  gravidade: z.enum(['info', 'warning', 'critical']),
});
export type Atividade = z.infer<typeof atividadeSchema>;

export const respostaDoHistoricoSchema = z.object({
  atividades: z.array(atividadeSchema),
  total: z.number().int().nonnegative(),
});
export type RespostaDoHistorico = z.infer<typeof respostaDoHistoricoSchema>;

/** Filtro por tipo de autor. */
export const origemDoHistoricoSchema = z.enum(['pessoas', 'bot', 'sistema']);
export type OrigemDoHistorico = z.infer<typeof origemDoHistoricoSchema>;

/** O que o servidor precisa ler para identificar quem aparece na página. */
export interface PortasDoHistorico {
  /** Papel atual de cada usuário **nesta** organização; quem saiu fica fora do mapa. */
  lerPapeis(userIds: readonly string[]): Promise<ReadonlyMap<string, PapelMembro>>;
  lerIdentidade(userId: string): Promise<IdentidadeDeExibicao>;
}

const ACAO_DO_ASSISTENTE = 'catalog.assistant_product_edit';

function autorSemPessoa(metadata: Record<string, unknown>): AutorDaAtividade {
  return metadata.origem === 'ia' ? { tipo: 'bot' } : { tipo: 'sistema' };
}

export async function montarHistorico(
  eventos: readonly EventoDaTrilha[],
  portas: PortasDoHistorico,
): Promise<Atividade[]> {
  const pessoas = [...new Set(eventos.flatMap((e) => (e.actorId ? [e.actorId] : [])))];
  const [papeis, identidades] = await Promise.all([
    pessoas.length > 0 ? portas.lerPapeis(pessoas) : Promise.resolve(new Map<string, PapelMembro>()),
    Promise.all(pessoas.map(async (id) => [id, await portas.lerIdentidade(id)] as const)),
  ]);
  const identidadePorId = new Map(identidades);

  return eventos.map((e) => {
    const identidade = e.actorId ? identidadePorId.get(e.actorId) : undefined;
    const autor: AutorDaAtividade = e.actorId && identidade
      ? { tipo: 'pessoa', userId: e.actorId, papel: papeis.get(e.actorId) ?? null, ...identidade }
      : autorSemPessoa(e.metadata);
    const definicao = getAuditEventDefinition(e.acao);
    return {
      id: e.id,
      acao: e.acao,
      descricao: definicao?.descricao ?? e.acao,
      gravidade: definicao?.severidade ?? 'info',
      recurso: e.recurso,
      recursoId: e.recursoId,
      correlationId: e.correlationId,
      createdAt: e.createdAt,
      autor,
      viaAssistente: e.acao === ACAO_DO_ASSISTENTE,
    };
  });
}
