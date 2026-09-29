import { autorizarCorrecaoOperacional, auditarCorrecao } from '@/lib/correcaoOperacionalServidor';
import { getCorrelationId } from '@/lib/observability/correlation';
import { financeiroRepository } from '@/repositories/financeiroRepository';
import { bling } from '@/services/bling';

import type { CorrecaoDeTituloDependencies } from './correcaoDeTitulo';

/** A composição real das duas correções de título: escopo verificado, repositório e Bling da organização. */
export const dependenciasDaCorrecaoDeTitulo: CorrecaoDeTituloDependencies = {
  autorizar: autorizarCorrecaoOperacional,
  store: financeiroRepository,
  bling: (scope) => bling.forVerifiedOrganization(scope),
  auditar: auditarCorrecao,
  correlationId: getCorrelationId,
};
