import { z } from 'zod';

/**
 * A situação de uma conta a pagar ou a receber no Bling, e como o ORBITA a
 * projeta no seu modelo de quatro estados.
 *
 * Fonte: `ContasDadosBaseDTO.situacao` no OpenAPI oficial (conferido em
 * 2026-09-29, `openapi-BVqLYFZn.json`): `1` Aberto, `2` Pago, `3` Parcial,
 * `4` Devolvido, `5` Cancelado, `6` Devolvido parcial, `7` Confirmado. O mesmo
 * vocabulário aparece no filtro `situacao` de `GET /contas/pagar`.
 *
 * ## A projeção é conservadora
 *
 * O modelo local tem `aberto`, `pago`, `cancelado` e `estornado`. Só os dois
 * códigos que o contrato **prova** — `2` Pago e `5` Cancelado — viram
 * liquidado ou terminal. Parcial, devolvido, devolvido parcial e confirmado
 * não têm equivalente local provado, e nenhum deles é transformado em
 * `cancelado` ou `estornado` por inferência: ficam `aberto`, que é a leitura
 * que não esconde dinheiro dos totais.
 *
 * O código original não se perde: a sincronização grava o número bruto em
 * `titulos_financeiros.situacao_bling` (migration 68).
 *
 * REINTRODUZIR O DEFEITO: volte a mapear `3` para `cancelado`. O caso
 * "3 Parcial nunca vira cancelado" de `situacaoDaContaBling.test.ts` falha.
 */
export const SITUACAO_DA_CONTA_BLING = {
  aberto: 1,
  pago: 2,
  parcial: 3,
  devolvido: 4,
  cancelado: 5,
  devolvidoParcial: 6,
  confirmado: 7,
} as const;

export type CodigoDaSituacaoDaConta = (typeof SITUACAO_DA_CONTA_BLING)[keyof typeof SITUACAO_DA_CONTA_BLING];

/** Código válido: inteiro de 1 a 7. Fora disso não é situação que o contrato conheça. */
export const codigoDaSituacaoDaContaSchema = z
  .number()
  .int()
  .min(1)
  .max(7)
  .transform((codigo) => codigo as CodigoDaSituacaoDaConta);

export type SituacaoLocalDoTitulo = 'aberto' | 'pago' | 'cancelado';

const PROJECAO: Record<CodigoDaSituacaoDaConta, SituacaoLocalDoTitulo> = {
  1: 'aberto',
  2: 'pago',
  3: 'aberto',
  4: 'aberto',
  5: 'cancelado',
  6: 'aberto',
  7: 'aberto',
};

export function projetarSituacaoDaConta(codigo: CodigoDaSituacaoDaConta): SituacaoLocalDoTitulo {
  return PROJECAO[codigo];
}
