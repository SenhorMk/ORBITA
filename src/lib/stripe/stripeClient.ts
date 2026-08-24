/**
 * stripeClient.ts
 * Ticket 38: Integração Stripe para assinatura e cobrança.
 * Verificação criptográfica e boundary de chamadas à API da Stripe.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export const stripeConfigSchema = z.object({
  secretKey: z.string().min(1, 'STRIPE_SECRET_KEY is required'),
  webhookSecret: z.string().min(1, 'STRIPE_WEBHOOK_SECRET is required'),
});

export function getStripeConfig() {
  const secretKey = process.env.STRIPE_SECRET_KEY || '';
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '';

  return {
    secretKey,
    webhookSecret,
    isConfigured: Boolean(
      secretKey &&
        webhookSecret &&
        !secretKey.includes('placeholder') &&
        !webhookSecret.includes('placeholder'),
    ),
  };
}

/**
 * Validação criptográfica de assinatura de webhook do Stripe (HMAC SHA-256 com timestamp drift tolerance).
 */
export function verifyStripeWebhookSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  secret: string,
  toleranceSeconds = 300,
): { valid: boolean; error?: string } {
  if (!signatureHeader) {
    return { valid: false, error: 'Assinatura stripe-signature ausente' };
  }

  if (!secret || secret.includes('placeholder')) {
    return { valid: false, error: 'STRIPE_WEBHOOK_SECRET não configurado' };
  }

  const parts = signatureHeader.split(',').reduce<Record<string, string>>((acc, item) => {
    const [k, v] = item.split('=');
    if (k && v) acc[k.trim()] = v.trim();
    return acc;
  }, {});

  const timestamp = parts.t;
  const signatureV1 = parts.v1;

  if (!timestamp || !signatureV1) {
    return { valid: false, error: 'Formato de assinatura stripe-signature inválido' };
  }

  const eventTime = parseInt(timestamp, 10);
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - eventTime) > toleranceSeconds) {
    return { valid: false, error: 'Timestamp da assinatura expirado (clock drift/replay)' };
  }

  const payloadToSign = `${timestamp}.${rawBody}`;
  const computedHmac = createHmac('sha256', secret).update(payloadToSign).digest('hex');

  try {
    const valid = timingSafeEqual(
      Buffer.from(signatureV1, 'hex'),
      Buffer.from(computedHmac, 'hex'),
    );
    return valid ? { valid: true } : { valid: false, error: 'Assinatura HMAC inválida' };
  } catch {
    return { valid: false, error: 'Falha na comparação de assinatura' };
  }
}
