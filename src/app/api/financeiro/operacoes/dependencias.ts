import { autorizarCorrecaoOperacional } from '@/lib/correcaoOperacionalServidor';
import { getCorrelationId } from '@/lib/observability/correlation';
import { bling } from '@/services/bling';

import { despesaStore } from '../despesaStoreSupabase';
import { operacoesDeContaPagarStore } from '../operacoesDeContaPagarStore';
import { createOperacoesHandlers } from './operacoesHandler';

/** As rotas de operações com a composição real: escopo verificado, Supabase e o Bling da organização. */
export const operacoesHandlers = createOperacoesHandlers({
  autorizar: autorizarCorrecaoOperacional,
  correlationId: getCorrelationId,
  operacoes: operacoesDeContaPagarStore,
  titulos: despesaStore,
  bling: (scope) => bling.forVerifiedOrganization(scope),
});
