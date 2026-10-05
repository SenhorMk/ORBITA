import { registrarFalhaInterna } from '@/lib/observability/falhaInterna';
import { checkRateLimit, DEFAULT_RATE_LIMIT_POLICIES } from '@/lib/rateLimit';
import { createSupabaseRateLimitStore } from '@/lib/rateLimitStore';
import { resolveVerifiedOrganizationScope } from '@/lib/requestOrganizationContext';
import { supabaseServer } from '@/lib/supabaseServer';
import { provedorDeBuscaConfigurado } from '@/services/empresas/buscaDeEmpresas';
import { consultarEmpresaPorCnpj } from '@/services/empresas/consultaPorCnpj';

import type { EmpresasDeps } from './handler';

/** A ligação de produção das rotas de empresa. */
export const dependenciasDeEmpresas: EmpresasDeps = {
  autorizar: async (request) => {
    const resultado = await resolveVerifiedOrganizationScope(request);
    return resultado._tag === 'RequestScopeResolved'
      ? { _tag: 'Autorizado', scope: resultado.scope }
      : { _tag: 'Negado', response: resultado.response };
  },
  limitar: (acao, chave) => checkRateLimit(createSupabaseRateLimitStore(supabaseServer), acao, chave, DEFAULT_RATE_LIMIT_POLICIES[acao]),
  consultarCnpj: (cnpj) => consultarEmpresaPorCnpj(cnpj, {
    fetch,
    baseUrl: process.env.BRASILAPI_CNPJ_URL || 'https://brasilapi.com.br/api/cnpj/v1',
  }),
  provedor: provedorDeBuscaConfigurado,
  registrarFalha: (operacao, causa, organizacaoId) => registrarFalhaInterna(operacao, new Error(causa), { organizacaoId }),
};
