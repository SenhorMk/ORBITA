import { NextResponse } from 'next/server';

import {
  RespostaDaMensageriaSchema,
  VERSAO_DO_CONTRATO_DA_MENSAGERIA,
  type CasoSac,
  type EventoRecebido,
} from '@/lib/integrations/contratoDaMensageria';
import { organizationContextStatus, type OrganizationContextResult } from '@/lib/organizationAuthorization';
import { organizationContextToScope, type VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';

/** As fronteiras que a rota usa; produção liga o Supabase, o teste liga fakes. */
export interface DependenciasDosCasos {
  readonly resolverContexto: (request: Request) => Promise<OrganizationContextResult>;
  readonly listarEventos: (scope: VerifiedOrganizationScope) => Promise<readonly EventoRecebido[]>;
  readonly listarCasos: (scope: VerifiedOrganizationScope) => Promise<readonly CasoSac[]>;
}

/** Mensagens recebidas e casos, só da organização da sessão e só para leitura. */
export function criarConsultaDeCasos(deps: DependenciasDosCasos) {
  return async function consultar(request: Request) {
    const contexto = await deps.resolverContexto(request);
    if (contexto._tag !== 'OrganizationContextResolved') {
      const status = organizationContextStatus(contexto);
      return NextResponse.json(
        { success: false, error: status === 503 ? 'Serviço de autorização indisponível' : 'Não autorizado' },
        { status },
      );
    }
    if (!contexto.context.capabilities.has('organization:access')) {
      return NextResponse.json({ success: false, error: 'Não autorizado' }, { status: 403 });
    }
    const scope = organizationContextToScope(contexto.context);
    const [eventos, casos] = await Promise.all([deps.listarEventos(scope), deps.listarCasos(scope)]);
    return NextResponse.json(RespostaDaMensageriaSchema.parse({
      success: true,
      versao: VERSAO_DO_CONTRATO_DA_MENSAGERIA,
      eventos,
      casos,
    }));
  };
}
