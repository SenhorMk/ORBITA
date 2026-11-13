import { z } from 'zod';

/**
 * Triagem de um caso SAC por IA (MSG-013).
 *
 * `TriagemV1Schema` é o que o modelo tem de devolver. É hipótese, nunca fato:
 * `numeroDoPedido` é o que a pessoa escreveu, não um pedido verificado, e
 * `confianca` não é probabilidade nem autorização. Os campos são fechados
 * (enums, tamanhos, objeto estrito) para o modelo não ter onde inventar.
 *
 * `RespostaDaTriagemSchema` é o contrato HTTP v1 do cockpit, que mostra o
 * resultado e também as falhas: sem orçamento, recusa, saída inválida.
 */
export const VERSAO_DO_SCHEMA_DA_TRIAGEM = 1;
export const VERSAO_DO_CONTRATO_DA_TRIAGEM = 1;

export const INTENCOES = [
  'rastrear_pedido',
  'status_do_pagamento',
  'troca_ou_devolucao',
  'produto_com_defeito',
  'produto_errado_ou_faltando',
  'cancelamento',
  'duvida_sobre_produto',
  'reclamacao',
  'elogio_ou_agradecimento',
  'outro',
] as const;

export const RESOLUCOES = ['troca', 'devolucao_do_dinheiro', 'reenvio', 'cancelamento', 'informacao', 'nenhuma', 'nao_informada'] as const;

const textoCurto = (maximo: number) => z.string().trim().min(1).max(maximo);

export const TriagemV1Schema = z.strictObject({
  versao: z.literal(VERSAO_DO_SCHEMA_DA_TRIAGEM),
  intencao: z.enum(INTENCOES),
  /** Uma frase, nas palavras do sistema, do que a pessoa quer. */
  motivo: textoCurto(200),
  confianca: z.enum(['baixa', 'media', 'alta']),
  /** O número que a pessoa citou, se citou. Não é pedido verificado. */
  numeroDoPedido: textoCurto(40).nullable(),
  resolucaoPedida: z.enum(RESOLUCOES),
  entidades: z.array(z.strictObject({
    tipo: z.enum(['produto', 'tamanho', 'cor', 'quantidade', 'data', 'valor', 'outro']),
    valor: textoCurto(100),
  })).max(10),
  informacoesFaltando: z.array(textoCurto(120)).max(5),
  /** Sugestão para o atendente; nunca é enviada sozinha. */
  proximaPergunta: textoCurto(300).nullable(),
  precisaDeHumano: z.boolean(),
  motivoDoHumano: textoCurto(200).nullable(),
});
export type TriagemV1 = z.infer<typeof TriagemV1Schema>;

/** Por que não há triagem utilizável. `falha` volta à fila; os demais ficam com o atendente. */
export const MotivoSemTriagemSchema = z.enum([
  'schema_invalido', 'recusa', 'entrada_bloqueada', 'sem_orcamento', 'limite_do_provedor', 'timeout',
  'erro_do_provedor', 'caso_mudou', 'interrompida',
]);
export type MotivoSemTriagem = z.infer<typeof MotivoSemTriagemSchema>;

export const ExecucaoDaTriagemSchema = z.strictObject({
  status: z.enum(['em_andamento', 'concluida', 'handoff', 'falha', 'obsoleta']),
  motivo: MotivoSemTriagemSchema.nullable(),
  triagem: TriagemV1Schema.nullable(),
  provedor: z.string(),
  modelo: z.string(),
  criadaEm: z.string(),
  concluidaEm: z.string().nullable(),
});
export type ExecucaoDaTriagem = z.infer<typeof ExecucaoDaTriagemSchema>;

export const RespostaDaTriagemSchema = z.strictObject({
  success: z.literal(true),
  versao: z.literal(VERSAO_DO_CONTRATO_DA_TRIAGEM),
  /** `null`: a conversa ainda não tem caso. */
  caso: z.strictObject({
    id: z.string().uuid(),
    fase: z.string(),
    /** Há triagem na fila ou em execução. */
    pendente: z.boolean(),
    execucao: ExecucaoDaTriagemSchema.nullable(),
  }).nullable(),
});
export type RespostaDaTriagem = z.infer<typeof RespostaDaTriagemSchema>;
