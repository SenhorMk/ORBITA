import { z } from 'zod';

/**
 * Contrato da reativação explícita de contato excluído no Bling (PRE-005).
 *
 * | resultado           | HTTP | O que aconteceu                                                         |
 * |---------------------|------|-------------------------------------------------------------------------|
 * | `Reactivated`       | 200  | o contato estava ativo no Bling e voltou ao ORBITA                      |
 * | `NotExcluded`       | 200  | não havia exclusão vigente; nada foi feito                              |
 * | `Blocked`           | 409  | o contato está excluído (404, `E`) ou não ativo (`I`, `S`) no Bling     |
 * | `Forbidden`         | 403  | o ator não administra a organização (conferido de novo no banco)        |
 * | `ProviderRefused`   | 502  | o Bling recusou a leitura; nada foi feito                               |
 * | `ReconcileRequired` | 503  | a leitura não prova o estado (indeterminada, outro id, situação vazia   |
 * |                     |      | ou fora das documentadas); nada foi feito                               |
 * | `InvalidRequest`    | 400  | o pedido não tem a forma esperada                                       |
 *
 * Nenhum evento do webhook reativa: este é o único caminho de volta, e ele só
 * reativa com o contato provado **ativo** (`A`) no Bling. Inativo (`I`) e sem
 * movimentação (`S`) existem lá, mas não são elegíveis para venda: a
 * reativação os recusa até o contato ser ativado no Bling.
 */
export const respostaDaReativacaoSchema = z.discriminatedUnion('resultado', [
  z.object({ resultado: z.literal('Reactivated') }),
  z.object({ resultado: z.literal('NotExcluded') }),
  z.object({ resultado: z.literal('Blocked'), motivo: z.enum(['ainda_excluido_no_bling', 'nao_ativo_no_bling']) }),
  z.object({ resultado: z.literal('Forbidden') }),
  z.object({ resultado: z.literal('ProviderRefused'), motivo: z.enum(['recusado_pelo_bling', 'limite_de_requisicoes']) }),
  z.object({ resultado: z.literal('ReconcileRequired') }),
  z.object({ resultado: z.literal('InvalidRequest') }),
]);

export type RespostaDaReativacao = z.infer<typeof respostaDaReativacaoSchema>;

export const STATUS_HTTP_DA_REATIVACAO: Record<RespostaDaReativacao['resultado'], number> = {
  Reactivated: 200,
  NotExcluded: 200,
  Blocked: 409,
  Forbidden: 403,
  ProviderRefused: 502,
  ReconcileRequired: 503,
  InvalidRequest: 400,
};
