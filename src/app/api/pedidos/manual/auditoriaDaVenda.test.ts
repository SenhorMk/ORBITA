import { describe, expect, it } from 'vitest';

import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import type { EventoComercial } from '@/services/auditoriaComercial';

import { comAuditoriaDaVenda } from './auditoriaDaVenda';
import type { ManualOrderStorePort, PersistManualOrderInput } from './ports';

const ORG = '11111111-1111-4111-8111-111111111111';
const ATOR = '22222222-2222-4222-8222-222222222222';
/** SAFETY: o escopo é entrada do teste. */
const scope = { organizationId: ORG, actorId: ATOR, role: 'member' } as unknown as VerifiedOrganizationScope;

function montar(store: Partial<ManualOrderStorePort>) {
  const eventos: Array<{ actorId: string; evento: EventoComercial }> = [];
  const decorado = comAuditoriaDaVenda(
    // SAFETY: só as duas portas decoradas são exercitadas.
    store as ManualOrderStorePort,
    async (s, evento) => { eventos.push({ actorId: s.actorId, evento }); },
    'corr_venda',
  );
  return { decorado, eventos };
}

// SAFETY: a entrada só precisa dos campos que o decorador lê.
const entrada = { scope, tentativaId: 't1', blingPedidoId: '777' } as unknown as PersistManualOrderInput;

describe('auditoria da venda manual (PRE-006C)', () => {
  it('venda gravada: evento com o ator verificado e os ids, devolvendo o resultado intacto', async () => {
    const { decorado, eventos } = montar({ async persistVenda() { return { _tag: 'PersistVendaOk', pedidoId: 'p1' }; } });

    expect(await decorado.persistVenda(entrada)).toEqual({ _tag: 'PersistVendaOk', pedidoId: 'p1' });
    expect(eventos).toEqual([{
      actorId: ATOR,
      evento: {
        acao: 'order.manual_sale_recorded', recurso: 'pedido', recursoId: 'p1', correlationId: 'corr_venda',
        metadata: { pedido_id: 'p1', bling_pedido_id: '777', tentativa_id: 't1' },
      },
    }]);
  });

  it('persistência que falhou ou perdeu a posse não vira "venda registrada"', async () => {
    for (const resultado of [
      { _tag: 'PersistVendaAmbigua', causa: null },
      { _tag: 'PersistVendaFalhouDefinitivamente', causa: null },
      { _tag: 'PersistVendaSemPosse' },
    ] as const) {
      const { decorado, eventos } = montar({ async persistVenda() { return resultado; } });
      await decorado.persistVenda(entrada);
      expect(eventos).toEqual([]);
    }
  });

  it('tentativa indeterminada gravada: evento crítico; desfecho que o banco recusou não é auditado', async () => {
    const gravado = montar({ async registrarDesfechoDaTentativa() { return { _tag: 'DesfechoGravado' }; } });
    await gravado.decorado.registrarDesfechoDaTentativa(scope, 't1', { estado: 'indeterminada', blingPedidoId: '777' }, 'em_andamento', 1);
    expect(gravado.eventos.map((e) => e.evento)).toEqual([{
      acao: 'order.manual_sale_unresolved', recurso: 'pedido', recursoId: null, correlationId: 'corr_venda',
      metadata: { tentativa_id: 't1', bling_pedido_id: '777' },
    }]);

    const recusado = montar({ async registrarDesfechoDaTentativa() { return { _tag: 'DesfechoNaoGravado', causa: null }; } });
    await recusado.decorado.registrarDesfechoDaTentativa(scope, 't1', { estado: 'indeterminada' }, 'em_andamento', 1);
    expect(recusado.eventos).toEqual([]);
  });

  it('`falhou` não gera evento: o Bling está limpo e a referência reabre', async () => {
    const { decorado, eventos } = montar({ async registrarDesfechoDaTentativa() { return { _tag: 'DesfechoGravado' }; } });

    await decorado.registrarDesfechoDaTentativa(scope, 't1', { estado: 'falhou' }, 'em_andamento', 1);

    expect(eventos).toEqual([]);
  });
});
