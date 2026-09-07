import { NextResponse } from 'next/server';

import type { ManualOrderResponseBody } from './ports';

/**
 * Construtores de resposta da venda manual, num lugar só.
 *
 * Existiam copiados em `handler.ts`, `compensacao.ts` e `preparacao.ts` — o
 * gate de qualidade sinalizou a duplicação quando um quarto módulo
 * (`decisaoDeTentativa.ts`) precisou dos mesmos dois.
 */
export function jsonDaVendaManual(body: ManualOrderResponseBody, status: number): NextResponse {
  return NextResponse.json(body, { status });
}

export function falhaDaVendaManual(
  error: string,
  status: number,
  extra: Partial<ManualOrderResponseBody> = {},
): NextResponse {
  return jsonDaVendaManual({ success: false, error, ...extra }, status);
}
