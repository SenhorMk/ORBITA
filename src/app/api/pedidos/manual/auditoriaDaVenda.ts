import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import type { AuditarComercial } from '@/services/auditoriaComercial';

import type { ManualOrderStorePort } from './ports';

/**
 * Trilha de auditoria da venda manual, sem tocar na máquina de estados.
 *
 * A venda já tem o ledger durável (`tentativas_venda_manual`), e todo desfecho
 * passa por duas portas do `store`: `persistVenda` (a venda gravada, na mesma
 * transação que fecha a tentativa) e `registrarDesfechoDaTentativa` (os
 * desfechos fora do caminho feliz). Decorar essas duas portas registra o
 * desfecho que o ledger realmente gravou:
 *
 * - venda gravada → `order.manual_sale_recorded`;
 * - tentativa `indeterminada` → `order.manual_sale_unresolved`;
 * - `falhou` não gera evento: o Bling está limpo e a referência reabre.
 *
 * Um desfecho que o banco recusou (`DesfechoNaoGravado`) não é auditado como
 * se tivesse acontecido.
 */
export function comAuditoriaDaVenda(
  store: ManualOrderStorePort,
  auditar: AuditarComercial,
  correlationId: string,
): ManualOrderStorePort {
  const evento = (
    scope: VerifiedOrganizationScope,
    acao: string,
    recursoId: string | null,
    metadata: Readonly<Record<string, string | null>>,
  ) => auditar(scope, { acao, recurso: 'pedido', recursoId, correlationId, metadata });

  return {
    ...store,
    async persistVenda(input) {
      const resultado = await store.persistVenda(input);
      if (resultado._tag === 'PersistVendaOk') {
        await evento(input.scope, 'order.manual_sale_recorded', resultado.pedidoId, {
          pedido_id: resultado.pedidoId,
          bling_pedido_id: input.blingPedidoId,
          tentativa_id: input.tentativaId,
        });
      }
      return resultado;
    },
    async registrarDesfechoDaTentativa(scope, tentativaId, desfecho, estadoEsperado, epoca) {
      const registro = await store.registrarDesfechoDaTentativa(scope, tentativaId, desfecho, estadoEsperado, epoca);
      if (registro._tag !== 'DesfechoGravado') return registro;
      if (desfecho.estado === 'indeterminada') {
        await evento(scope, 'order.manual_sale_unresolved', null, {
          tentativa_id: tentativaId,
          bling_pedido_id: desfecho.blingPedidoId ?? null,
        });
      } else if (desfecho.estado === 'concluida' && desfecho.pedidoId) {
        await evento(scope, 'order.manual_sale_recorded', desfecho.pedidoId, {
          pedido_id: desfecho.pedidoId,
          bling_pedido_id: desfecho.blingPedidoId ?? null,
          tentativa_id: tentativaId,
        });
      }
      return registro;
    },
  };
}
