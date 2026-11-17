import { NextResponse } from 'next/server';
import { z } from 'zod';

import { RespostaDaTriagemSchema, VERSAO_DO_CONTRATO_DA_TRIAGEM } from '@/lib/integrations/contratoDaTriagem';
import { organizationContextStatus, type OrganizationContextResult } from '@/lib/organizationAuthorization';
import { organizationContextToScope, type VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import { TriagemIndisponivel, type LeituraDaTriagem } from '@/services/sac/leituraDaTriagem';

export interface DependenciasDaTriagem {
  readonly resolverContexto: (request: Request) => Promise<OrganizationContextResult>;
  readonly ler: (scope: VerifiedOrganizationScope, conversaId: string) => Promise<LeituraDaTriagem>;
}

/** Ler a triagem é parte de atender, como ler a conversa (MSG-008/010). */
const CAPACIDADE_DE_ATENDER = 'organization:access' as const;
const ConversaSchema = z.object({ conversaId: z.string().uuid() });

const recusar = (error: string, status: number) => NextResponse.json({ success: false, error }, { status });

/** A triagem do caso atual da conversa, só da organização da sessão. Só leitura. */
export function criarRotaDaTriagem(deps: DependenciasDaTriagem) {
  return async function lerTriagem(request: Request) {
    const contexto = await deps.resolverContexto(request);
    if (contexto._tag !== 'OrganizationContextResolved') {
      const status = organizationContextStatus(contexto);
      return recusar(status === 503 ? 'Serviço de autorização indisponível' : 'Não autorizado', status);
    }
    if (!contexto.context.capabilities.has(CAPACIDADE_DE_ATENDER)) return recusar('Sem permissão para atender nesta organização.', 403);

    const parsed = ConversaSchema.safeParse({ conversaId: new URL(request.url).searchParams.get('conversaId') });
    if (!parsed.success) return recusar('Parâmetro conversaId (UUID) é obrigatório.', 400);

    try {
      const leitura = await deps.ler(organizationContextToScope(contexto.context), parsed.data.conversaId);
      if (leitura._tag === 'ConversaNaoEncontrada') return recusar('Conversa não encontrada', 404);
      return NextResponse.json(RespostaDaTriagemSchema.parse({ success: true, versao: VERSAO_DO_CONTRATO_DA_TRIAGEM, caso: leitura.caso }));
    } catch (erro: unknown) {
      if (erro instanceof TriagemIndisponivel) return recusar('Triagem indisponível no momento.', 503);
      throw erro;
    }
  };
}
