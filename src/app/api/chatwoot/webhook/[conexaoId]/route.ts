import { NextResponse } from 'next/server';
import { z } from 'zod';
import { lerCorpoLimitado } from '@/lib/http/corpoLimitado';
import { handleChatwootWebhookDelivery } from '@/services/chatwoot/chatwootWebhookService';

export const dynamic = 'force-dynamic';

const conexaoIdParamSchema = z.string().uuid();

/** Maior entrega aceita. Um evento de mensagem do Chatwoot tem poucos KiB. */
const LIMITE_DO_CORPO_BYTES = 256 * 1024;

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

  const corpo = await lerCorpoLimitado(request, LIMITE_DO_CORPO_BYTES);
  if (corpo._tag === 'CorpoGrandeDemais') {
    return NextResponse.json({ success: false, error: 'Payload grande demais' }, { status: 413 });
  }

  const outcome = await handleChatwootWebhookDelivery({
    conexaoId: conexaoIdParsed.data,
    rawBody: corpo.bytes,
    signatureHeader: request.headers.get('x-chatwoot-signature'),
    timestampHeader: request.headers.get('x-chatwoot-timestamp'),
    deliveryHeader: request.headers.get('x-chatwoot-delivery'),
  });

  return NextResponse.json(outcome.body, { status: outcome.status });
}
