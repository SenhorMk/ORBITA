/**
 * handlers.ts
 * Ticket 14: HTTP adapter para POST /api/stripe/checkout, com dependências
 * injetáveis (mesmo padrão de `src/app/api/bling/pedidos/[id]/handlers.ts`).
 * O cliente nunca envia `priceId`, `customerId`, `organizationId` ou uma URL
 * completa de retorno — apenas `plano_slug`/`intervalo` e, opcionalmente, um
 * path relativo dentro da origem allowlisted pelo servidor.
 */

import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { organizationContextStatus, type OrganizationContextResult } from '@/lib/organizationAuthorization';
import { createOrganizationCheckoutSession } from '@/services/stripe/checkoutService';
import type { StripeBillingPort } from '@/services/stripe/stripeBillingPort';
import type { StripeConfigResult } from '@/services/stripe/stripeConfig';

const checkoutInputSchema = z.object({
  plano_slug: z.enum(['pro', 'enterprise']),
  intervalo: z.enum(['monthly', 'yearly']).default('monthly'),
  /** Path relativo opcional. Nunca uma URL absoluta nem protocol-relative (`//`). */
  return_path: z
    .string()
    .regex(/^\/(?!\/)\S*$/, 'return_path deve ser um path relativo iniciando com "/"')
    .optional(),
});

export interface CheckoutHandlerDependencies {
  readonly resolveContext: (request: Request) => Promise<OrganizationContextResult>;
  readonly supabase: SupabaseClient;
  readonly billingPort: StripeBillingPort;
  /** Resultado do parser de config: inválido/ausente devolve 503 sem chamar o provider. */
  readonly configResult: StripeConfigResult;
}

function billingFailureResponse(reason: string, message: string | undefined, status: number | undefined) {
  const httpStatus =
    status ??
    (reason === 'unconfigured'
      ? 503
      : reason === 'network' || reason === 'timeout'
        ? 503
        : reason === 'invalid-response'
          ? 502
          : 502);
  return NextResponse.json(
    { error: message ?? 'Falha ao criar sessão de checkout Stripe' },
    { status: httpStatus },
  );
}

/** Cria os handlers HTTP de checkout sobre dependências injetadas. */
export function createCheckoutHandlers(dependencies: CheckoutHandlerDependencies) {
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
          { error: 'Apenas administradores podem gerenciar o plano da organização' },
          { status: 403 },
        );
      }

      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
      }

      const parseResult = checkoutInputSchema.safeParse(body);
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

      const { plano_slug, intervalo, return_path } = parseResult.data;
      const organizationId = contextResult.context.organizationId;

      const result = await createOrganizationCheckoutSession(
        { supabase: dependencies.supabase, billingPort: dependencies.billingPort, config: dependencies.configResult.config },
        { organizationId, planoSlug: plano_slug, intervalo, returnPath: return_path },
      );

      if (result._tag === 'StripeBillingFailed') {
        return billingFailureResponse(result.reason, result.message, result.status);
      }

      return NextResponse.json({
        url: result.data.url,
        session_id: result.data.sessionId,
      });
    },
  };
}
