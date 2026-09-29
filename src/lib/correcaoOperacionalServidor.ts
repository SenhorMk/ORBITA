import { NextResponse } from 'next/server';

import { escopoTemCapacidade, resolveVerifiedOrganizationScope } from '@/lib/requestOrganizationContext';
import { supabaseServer } from '@/lib/supabaseServer';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import { recordAuditEvent } from '@/services/auditService';

/**
 * As duas peças de servidor comuns às correções operacionais (excluir contato,
 * excluir lançamento, cancelar despesa).
 *
 * **Autorização:** o escopo vem do vínculo persistido; a capacidade exigida é
 * `organization:manage` (owner e admin). Nada do corpo da requisição entra
 * nesta decisão.
 */
export async function autorizarCorrecaoOperacional(request: Request): Promise<
  | { readonly _tag: 'Autorizado'; readonly scope: VerifiedOrganizationScope }
  | { readonly _tag: 'Negado'; readonly response: NextResponse }
> {
  const resolvido = await resolveVerifiedOrganizationScope(request);
  if (resolvido._tag !== 'RequestScopeResolved') return { _tag: 'Negado', response: resolvido.response };
  if (!escopoTemCapacidade(resolvido.scope, 'organization:manage')) {
    return {
      _tag: 'Negado',
      response: NextResponse.json(
        { success: false, error: 'Acesso negado: apenas quem administra a organização pode realizar esta ação.' },
        { status: 403 },
      ),
    };
  }
  return { _tag: 'Autorizado', scope: resolvido.scope };
}

/**
 * Grava o evento pela infraestrutura existente: `recordAuditEvent` valida o
 * nome e a metadata contra o catálogo e chama `registrar_evento_auditoria`,
 * que confere de novo que o ator é membro da organização.
 */
export async function auditarCorrecao(
  scope: VerifiedOrganizationScope,
  evento: {
    readonly acao: string;
    readonly recurso: string;
    readonly recursoId: string;
    readonly correlationId: string;
    readonly metadata: Readonly<Record<string, string | boolean>>;
  },
): Promise<void> {
  await recordAuditEvent(supabaseServer, scope, {
    acao: evento.acao,
    recurso: evento.recurso,
    recursoId: evento.recursoId,
    correlationId: evento.correlationId,
    metadata: { ...evento.metadata },
  });
}
