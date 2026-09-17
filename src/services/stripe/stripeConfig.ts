/**
 * stripeConfig.ts
 * Config parser do provider Stripe. Fronteira de configuração:
 * nenhum caller obtém secret key / webhook secret / Price IDs sem passar por
 * este parser. Nada aqui é exposto em `NEXT_PUBLIC_*`.
 */

import { z } from 'zod';

const PLACEHOLDER_SUBSTRINGS = ['placeholder', 'your-', 'replace-me', 'change-me', 'changeme'];

function isPlaceholder(value: string): boolean {
  const lower = value.toLowerCase();
  return PLACEHOLDER_SUBSTRINGS.some((needle) => lower.includes(needle));
}

/** Segredo obrigatório: comprimento mínimo e nunca um valor placeholder. */
function secretField(label: string, minLength = 20) {
  return z
    .string({ message: `${label} é obrigatório` })
    .min(minLength, `${label} deve ter ao menos ${minLength} caracteres`)
    .refine((value) => !isPlaceholder(value), `${label} não pode ser um valor placeholder`);
}

/** Price ID obrigatório: prefixo `price_` real da Stripe, nunca placeholder. */
function priceIdField(label: string) {
  return z
    .string({ message: `${label} é obrigatório` })
    .min(6, `${label} é obrigatório`)
    .refine((value) => !isPlaceholder(value), `${label} não pode ser um valor placeholder`)
    .refine((value) => value.startsWith('price_'), `${label} deve ser um Price ID Stripe válido (price_...)`);
}

export const stripeRuntimeConfigSchema = z.object({
  secretKey: secretField('STRIPE_SECRET_KEY'),
  webhookSecret: secretField('STRIPE_WEBHOOK_SECRET'),
  appBaseUrl: z
    .string({ message: 'STRIPE_APP_BASE_URL é obrigatório' })
    .url('STRIPE_APP_BASE_URL deve ser uma URL absoluta')
    .refine((value) => !isPlaceholder(value), 'STRIPE_APP_BASE_URL não pode ser um valor placeholder'),
  prices: z.object({
    pro_monthly: priceIdField('STRIPE_PRICE_PRO_MONTHLY'),
    pro_yearly: priceIdField('STRIPE_PRICE_PRO_YEARLY'),
    enterprise_monthly: priceIdField('STRIPE_PRICE_ENTERPRISE_MONTHLY'),
    enterprise_yearly: priceIdField('STRIPE_PRICE_ENTERPRISE_YEARLY'),
  }),
  checkoutEnabled: z.boolean(),
});
export type StripeRuntimeConfig = z.infer<typeof stripeRuntimeConfigSchema>;

export type StripeConfigResult =
  | { readonly _tag: 'StripeConfigValid'; readonly config: StripeRuntimeConfig }
  | { readonly _tag: 'StripeConfigInvalid'; readonly issues: readonly string[] };

/** Ambiente aceito pelo parser: qualquer mapa de variáveis (o `process.env` real ou um fixture de teste). */
export type StripeConfigEnv = Readonly<Record<string, string | undefined>>;

/** Lê e valida a configuração Stripe do ambiente do servidor. Nunca lança. */
export function parseStripeRuntimeConfig(env: StripeConfigEnv = process.env): StripeConfigResult {
  const candidate = {
    secretKey: env.STRIPE_SECRET_KEY ?? '',
    webhookSecret: env.STRIPE_WEBHOOK_SECRET ?? '',
    appBaseUrl: env.STRIPE_APP_BASE_URL ?? '',
    prices: {
      pro_monthly: env.STRIPE_PRICE_PRO_MONTHLY ?? '',
      pro_yearly: env.STRIPE_PRICE_PRO_YEARLY ?? '',
      enterprise_monthly: env.STRIPE_PRICE_ENTERPRISE_MONTHLY ?? '',
      enterprise_yearly: env.STRIPE_PRICE_ENTERPRISE_YEARLY ?? '',
    },
    checkoutEnabled: env.STRIPE_CHECKOUT_ENABLED === 'true',
  };

  const result = stripeRuntimeConfigSchema.safeParse(candidate);
  if (!result.success) {
    return {
      _tag: 'StripeConfigInvalid',
      issues: result.error.issues.map((issue) => issue.message),
    };
  }
  return { _tag: 'StripeConfigValid', config: result.data };
}

export const PLANO_SLUGS = ['pro', 'enterprise'] as const;
export type PlanoSlugPago = (typeof PLANO_SLUGS)[number];
export const INTERVALOS = ['monthly', 'yearly'] as const;
export type Intervalo = (typeof INTERVALOS)[number];

/** Allowlist server-side: plano + intervalo -> Price ID. O cliente nunca envia Price ID. */
export function resolvePriceId(
  config: StripeRuntimeConfig,
  planoSlug: PlanoSlugPago,
  intervalo: Intervalo,
): string {
  const key = `${planoSlug}_${intervalo}` as keyof StripeRuntimeConfig['prices'];
  return config.prices[key];
}

/**
 * Constrói uma URL de retorno absoluta a partir da origem única configurada no
 * servidor (`STRIPE_APP_BASE_URL`) e um path relativo opcional fornecido pelo
 * cliente. O cliente nunca controla a origem, apenas o path dentro dela.
 */
export function buildAllowlistedReturnUrl(config: StripeRuntimeConfig, relativePath: string): string {
  const base = new URL(config.appBaseUrl);
  const target = new URL(relativePath, base);
  if (target.origin !== base.origin) {
    throw new Error('SAFETY: path relativo resultou em origem diferente da allowlist configurada');
  }
  return target.toString();
}
