import { z } from 'zod';

/**
 * Contrato da reativação explícita de contato excluído no Bling (PRE-005).
 *
 * | resultado           | HTTP | O que aconteceu                                                         |
 * |---------------------|------|-------------------------------------------------------------------------|
 * | `Reactivated`       | 200  | o contato estava ativo no Bling e voltou ao ORBITA                      |
 * | `NotExcluded`       | 200  | não havia exclusão vigente; nada foi feito                              |
 * | `Blocked`           | 409  | o contato continua excluído no Bling; nada foi feito                    |
 * | `Forbidden`         | 403  | o ator não administra a organização (conferido de novo no banco)        |
 * | `ProviderRefused`   | 502  | o Bling recusou a leitura; nada foi feito                               |
 * | `ReconcileRequired` | 503  | o estado no Bling não pôde ser confirmado; nada foi feito               |
 * | `InvalidRequest`    | 400  | o pedido não tem a forma esperada                                       |
 *
 * Nenhum evento do webhook reativa: este é o único caminho de volta, e ele só
 * reativa com o contato provado ativo no Bling.
 */
export const respostaDaReativacaoSchema = z.discriminatedUnion('resultado', [
  z.object({ resultado: z.literal('Reactivated') }),
  z.object({ resultado: z.literal('NotExcluded') }),
  z.object({ resultado: z.literal('Blocked'), motivo: z.literal('ainda_excluido_no_bling') }),
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
