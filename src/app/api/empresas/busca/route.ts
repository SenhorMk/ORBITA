import { dependenciasDeEmpresas } from '../dependencias';
import { createBuscaDeEmpresasHandler } from '../handler';

/** `GET /api/empresas/busca?termo=` — sugestões de empresa por nome. Ver `handler.ts`. */
export const GET = createBuscaDeEmpresasHandler(dependenciasDeEmpresas);
