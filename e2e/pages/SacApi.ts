import type { APIResponse, Page } from '@playwright/test';

import { cabecalhosAutenticados } from './sessaoAutenticada';

export async function consultarCasosSac(page: Page): Promise<APIResponse> {
  return page.request.get('/api/sac/casos', { headers: await cabecalhosAutenticados(page) });
}
