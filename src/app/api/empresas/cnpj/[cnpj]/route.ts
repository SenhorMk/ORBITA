import type { NextResponse } from 'next/server';

import { dependenciasDeEmpresas } from '../../dependencias';
import { createConsultaPorCnpjHandler } from '../../handler';

const consultar = createConsultaPorCnpjHandler(dependenciasDeEmpresas);

/** `GET /api/empresas/cnpj/[cnpj]` — dados cadastrais completos de uma empresa. Ver `handler.ts`. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ cnpj: string }> },
): Promise<NextResponse> {
  const { cnpj } = await params;
  return consultar(request, cnpj);
}
