import { z } from 'zod';
import { PendenciaDaTrocaSchema } from './contratoDaPropostaDeTroca';

const id = z.string().uuid();
const digest = z.string().regex(/^[0-9a-f]{64}$/u);
const versao = z.number().int().min(1).max(2_147_483_647);
const referencia = { versao, digest };
export const EntradaDaPropostaSchema = z.strictObject({
  tipo: z.enum(['troca', 'devolucao']),
  pedidoId: id.optional(),
  itemId: id.optional(),
  quantidade: z.number().int().min(1).max(10_000).optional(),
  motivo: z.enum(['avaria', 'defeito', 'arrependimento', 'outro']).optional(),
  substitutoId: id.optional(),
}).refine(p => (!p.itemId || p.pedidoId) && (p.tipo === 'troca' || !p.substitutoId));

const comando = { conversaId: id, operacaoId: id };
export const ComandoDePropostaSchema = z.discriminatedUnion('acao', [
  z.strictObject({ ...comando, acao: z.literal('criar'), entrada: EntradaDaPropostaSchema }),
  z.strictObject({ ...comando, ...referencia, acao: z.literal('editar'), entrada: EntradaDaPropostaSchema }),
  z.strictObject({ ...comando, ...referencia, acao: z.literal('aprovar') }),
  z.strictObject({ ...comando, ...referencia, acao: z.literal('rejeitar') }),
]);
export type ComandoDeProposta = z.infer<typeof ComandoDePropostaSchema>;

const situacao = z.enum(['rascunho', 'aprovada', 'rejeitada']);
const recibo = z.strictObject({ estado: z.literal('ok'), casoId: id, ...referencia, situacao });
const pendencia = z.union([PendenciaDaTrocaSchema, z.enum(['compatibilidade', 'frescor_catalogo', 'substituto_indisponivel'])]);
export const PropostaAtualSchema = recibo.extend({
  situacao: z.enum(['rascunho', 'aprovada', 'rejeitada', 'vencida']),
  entrada: EntradaDaPropostaSchema,
  pendencias: z.array(pendencia),
  podeAprovar: z.boolean(),
  podeRejeitar: z.boolean(),
  fatosAlterados: z.boolean(),
  expiraEm: z.iso.datetime({ offset: true }),
});
export type PropostaAtual = z.infer<typeof PropostaAtualSchema>;

const erro = z.union([
  z.strictObject({ estado: z.enum(['sem_permissao', 'entrada_invalida', 'nao_encontrado', 'referencia_sem_prova',
    'operacao_divergente', 'conflito', 'ja_decidida', 'vencida', 'fatos_alterados']) }),
  z.strictObject({ estado: z.literal('bloqueada'), pendencias: z.array(pendencia) }),
]);
export const ResultadoDaDecisaoSchema = z.union([recibo, erro]);
export const ResultadoDaLeituraSchema = z.union([PropostaAtualSchema, z.strictObject({ estado: z.literal('sem_proposta') }), erro]);
