import { autorizarCorrecaoOperacional } from '@/lib/correcaoOperacionalServidor';
import { getCorrelationId } from '@/lib/observability/correlation';
import { bling } from '@/services/bling';

import { despesaStore } from '../despesaStoreSupabase';
import { hojeEmSaoPaulo } from '../hojeEmSaoPaulo';
import { operacoesDeContaPagarStore } from '../operacoesDeContaPagarStore';
import { createOperacoesHandlers } from './operacoesHandler';

/**
 * As rotas de operações com a composição real: escopo verificado, Supabase e o
 * Bling da organização. A escrita no Bling só é composta para a quitação
 * explícita; a reconciliação recebe apenas as leituras.
 */
export const operacoesHandlers = createOperacoesHandlers({
  autorizar: autorizarCorrecaoOperacional,
  correlationId: getCorrelationId,
  operacoes: operacoesDeContaPagarStore,
  titulos: despesaStore,
  bling: (scope) => bling.forVerifiedOrganization(scope),
  escrita: (scope) => {
    const client = bling.forVerifiedOrganization(scope);
    return {
      bling: {
        obterPortadorPadrao: () => client.obterContaFinanceiraPadraoId(),
        baixarContaPagar: (id, payload) => client.baixarContaPagar(id, payload),
      },
      store: despesaStore,
      hoje: hojeEmSaoPaulo,
    };
  },
});
