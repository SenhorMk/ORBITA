import { NextResponse } from 'next/server';
import { z } from 'zod';
import { handleChatwootWebhookDelivery } from '@/services/chatwoot/chatwootWebhookService';

export const dynamic = 'force-dynamic';

const conexaoIdParamSchema = z.string().uuid();

interface RouteContext {
  readonly params: Promise<{ readonly conexaoId: string }>;
}

export async function GET() {
  return NextResponse.json({
    status: 'ok',
    message: 'Webhook do Chatwoot ativo e pronto para receber notificações de contatos, conversas e mensagens.',
    timestamp: new Date().toISOString(),
  });
}

/**
 * Inbound Adapter: parse the connection-scoped delivery URL, hand the raw
 * request off to the application service, and render its outcome. All
 * authentication, idempotency, and persistence policy live in
 * `chatwootWebhookService` — this handler owns only protocol translation.
 */
export async function POST(request: Request, context: RouteContext) {
  const { conexaoId: rawConexaoId } = await context.params;
  const conexaoIdParsed = conexaoIdParamSchema.safeParse(rawConexaoId);
  if (!conexaoIdParsed.success) {
    return NextResponse.json({ success: false, error: 'Conexão inválida' }, { status: 404 });
  }

  const outcome = await handleChatwootWebhookDelivery({
    conexaoId: conexaoIdParsed.data,
    rawBody: await request.text(),
    signatureHeader: request.headers.get('x-chatwoot-signature'),
    timestampHeader: request.headers.get('x-chatwoot-timestamp'),
  });

  return NextResponse.json(outcome.body, { status: outcome.status });
}
