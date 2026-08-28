/**
 * handlers.ts
 * Ticket 14: HTTP adapter para POST /api/stripe/portal, com dependências
 * injetáveis (mesmo padrão de `src/app/api/bling/pedidos/[id]/handlers.ts`).
 * O cliente nunca envia `customerId` nem uma URL completa de retorno —
 * apenas, opcionalmente, um path relativo dentro da origem allowlisted.
 */

import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { organizationContextStatus, type OrganizationContextResult } from '@/lib/organizationAuthorization';
import { createOrganizationPortalSession } from '@/services/stripe/portalService';
import type { StripeBillingPort } from '@/services/stripe/stripeBillingPort';
import type { StripeConfigResult } from '@/services/stripe/stripeConfig';

const portalInputSchema = z.object({
  return_path: z
    .string()
    .regex(/^\/(?!\/)\S*$/, 'return_path deve ser um path relativo iniciando com "/"')
    .optional(),
});

export interface PortalHandlerDependencies {
  readonly resolveContext: (request: Request) => Promise<OrganizationContextResult>;
  readonly supabase: SupabaseClient;
  readonly billingPort: StripeBillingPort;
  readonly configResult: StripeConfigResult;
}

function billingFailureResponse(reason: string, message: string | undefined, status: number | undefined) {
  const httpStatus =
    status ??
    (reason === 'unconfigured'
      ? 400
      : reason === 'network' || reason === 'timeout'
        ? 503
        : reason === 'invalid-response'
          ? 502
          : 502);
  return NextResponse.json(
    { error: message ?? 'Falha ao criar sessão do portal de faturamento Stripe' },
    { status: httpStatus },
  );
}

/** Cria os handlers HTTP do portal de faturamento sobre dependências injetadas. */
export function createPortalHandlers(dependencies: PortalHandlerDependencies) {
  return {
    async POST(req: Request): Promise<Response> {
      const contextResult = await dependencies.resolveContext(req);
      if (contextResult._tag !== 'OrganizationContextResolved') {
        const status = organizationContextStatus(contextResult);
        return NextResponse.json(
          { error: status === 503 ? 'Serviço de autorização indisponível' : 'Não autorizado' },
          { status },
        );
      }

      if (!contextResult.context.capabilities.has('organization:manage')) {
        return NextResponse.json(
          { error: 'Apenas administradores podem acessar o portal de faturamento' },
          { status: 403 },
        );
      }

      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
      }

      const parseResult = portalInputSchema.safeParse(body);
      if (!parseResult.success) {
        return NextResponse.json(
          { error: 'Dados inválidos', details: parseResult.error.flatten() },
          { status: 400 },
        );
      }

      if (dependencies.configResult._tag !== 'StripeConfigValid') {
        return NextResponse.json(
          { error: 'Faturamento Stripe não configurado neste ambiente' },
          { status: 503 },
        );
      }

      const organizationId = contextResult.context.organizationId;

      const result = await createOrganizationPortalSession(
        { supabase: dependencies.supabase, billingPort: dependencies.billingPort, config: dependencies.configResult.config },
        { organizationId, returnPath: parseResult.data.return_path },
      );

      if (result._tag === 'StripeBillingFailed') {
        return billingFailureResponse(result.reason, result.message, result.status);
      }

      return NextResponse.json({ url: result.data.url });
    },
  };
}
