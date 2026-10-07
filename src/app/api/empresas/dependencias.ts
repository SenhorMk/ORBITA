import { registrarFalhaInterna } from '@/lib/observability/falhaInterna';
import { checkRateLimit, DEFAULT_RATE_LIMIT_POLICIES } from '@/lib/rateLimit';
import { createSupabaseRateLimitStore } from '@/lib/rateLimitStore';
import { resolveVerifiedOrganizationScope } from '@/lib/requestOrganizationContext';
import { supabaseServer } from '@/lib/supabaseServer';
import { consultarEmpresaPorCnpj } from '@/services/empresas/consultaPorCnpj';

import type { EmpresasDeps } from './handler';

/**
 * Endpoint da BrasilAPI, decidido no servidor: variável só de servidor (nunca
 * `NEXT_PUBLIC_*`) ou o padrão público. Nada do navegador vira URL.
 */
const BRASILAPI_CNPJ = process.env.BRASILAPI_CNPJ_URL || 'https://brasilapi.com.br/api/cnpj/v1';

/** A ligação de produção da consulta por CNPJ. */
export const dependenciasDeEmpresas: EmpresasDeps = {
  autorizar: async (request) => {
    const resultado = await resolveVerifiedOrganizationScope(request);
    return resultado._tag === 'RequestScopeResolved'
      ? { _tag: 'Autorizado', scope: resultado.scope }
      : { _tag: 'Negado', response: resultado.response };
  },
  limitar: (acao, chave) => checkRateLimit(createSupabaseRateLimitStore(supabaseServer), acao, chave, DEFAULT_RATE_LIMIT_POLICIES[acao]),
  consultarCnpj: (cnpj) => consultarEmpresaPorCnpj(cnpj, { fetch, baseUrl: BRASILAPI_CNPJ }),
  registrarFalha: (operacao, causa, organizacaoId) => registrarFalhaInterna(operacao, new Error(causa), { organizacaoId }),
};
