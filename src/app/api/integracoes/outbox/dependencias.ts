import { resolveActiveRequestOrganizationContext } from '@/lib/requestOrganizationContext';
import { supabaseServer } from '@/lib/supabaseServer';
import { recordAuditEvent } from '@/services/auditService';
import { autorizarReplay, listarEventosComAtencao, resolverDesconhecido } from '@/services/outbox/decisoesDaOutbox';

import type { DependenciasDaOutbox } from './handlers';

/** As dependências de produção das rotas da outbox. */
export const dependenciasDaOutbox: DependenciasDaOutbox = {
  resolverContexto: resolveActiveRequestOrganizationContext,
  listar: (scope) => listarEventosComAtencao(supabaseServer, scope),
  autorizarReplay: (scope, eventoId) => autorizarReplay(supabaseServer, scope, eventoId),
  resolver: (scope, eventoId, entrada) => resolverDesconhecido(supabaseServer, scope, eventoId, entrada),
  auditar: async (scope, acao, eventoId, metadata) => {
    await recordAuditEvent(supabaseServer, scope, { acao, recurso: 'outbox_evento', recursoId: eventoId, metadata })
      .catch(() => console.error('❌ outbox: auditoria da decisão falhou.'));
  },
};
