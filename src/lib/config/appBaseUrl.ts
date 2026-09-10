import { z } from 'zod';

/**
 * Origem pública estável da aplicação.
 *
 * Existe porque a URL de retorno do OAuth do Bling era montada com
 * `window.location.origin`. Num deploy de preview da Vercel isso produz
 * `orbita-<hash>.vercel.app`, endereço que muda a cada deploy — e a URL de
 * retorno precisa ser cadastrada **uma vez** dentro do Bling.
 *
 * Pior que o endereço envelhecer: o cookie `orbita_oauth_transaction` é
 * gravado no host onde o OAuth começou. Se o retorno cadastrado no Bling
 * apontar para outro host, o cookie não acompanha, a transação não pode ser
 * consumida e a conexão falha mesmo com credenciais corretas. Iniciar o fluxo
 * numa origem e recebê-lo em outra nunca funciona.
 *
 * Por isso a origem é decidida no **servidor**, a partir de configuração, e
 * nunca inferida do navegador.
 */

const PLACEHOLDER_PATTERN = /placeholder|seu-dominio|example\.com|localhost:0/iu;

const baseUrlSchema = z
  .string()
  .url()
  .refine((value) => !PLACEHOLDER_PATTERN.test(value), 'origem configurada é um valor placeholder');

export type AppBaseUrlResult =
  | { readonly _tag: 'AppBaseUrlResolved'; readonly origin: string }
  | { readonly _tag: 'AppBaseUrlMissing' };

/** Variáveis lidas, em ordem de precedência. */
export interface AppBaseUrlEnvironment {
  readonly APP_BASE_URL?: string;
  readonly STRIPE_APP_BASE_URL?: string;
}

/**
 * Resolve a origem pública estável.
 *
 * `APP_BASE_URL` é o nome canônico. `STRIPE_APP_BASE_URL` é aceito como
 * segunda opção porque já descreve, no `.env.example`, exatamente a mesma
 * coisa — "single allowlisted origin used to build return URLs" — e o
 * proprietário já a configurou. São o mesmo endereço; exigir duas variáveis
 * para um único conceito só cria uma chance a mais de divergirem.
 */
export function resolveAppBaseUrl(environment: AppBaseUrlEnvironment): AppBaseUrlResult {
  for (const candidate of [environment.APP_BASE_URL, environment.STRIPE_APP_BASE_URL]) {
    const parsed = baseUrlSchema.safeParse(candidate?.trim());
    if (parsed.success) {
      // Normaliza para a origem pura: barra final ou caminho não pertencem a
      // uma URL de retorno cadastrada no provedor.
      return { _tag: 'AppBaseUrlResolved', origin: new URL(parsed.data).origin };
    }
  }

  return { _tag: 'AppBaseUrlMissing' };
}

/** Caminho do retorno OAuth do Bling, cadastrado no aplicativo dentro do Bling. */
export const BLING_CALLBACK_PATH = '/api/bling/callback';

/**
 * URL de retorno do Bling, ou `null` quando a origem estável não está
 * configurada. `null` é deliberado: a tela precisa dizer que falta configurar,
 * em vez de exibir um endereço que vai quebrar no próximo deploy.
 */
export function resolveBlingCallbackUrl(environment: AppBaseUrlEnvironment): string | null {
  const base = resolveAppBaseUrl(environment);
  return base._tag === 'AppBaseUrlResolved' ? `${base.origin}${BLING_CALLBACK_PATH}` : null;
}

/** Caminho do webhook do Chatwoot de uma conexão, colado dentro do Chatwoot. */
export function chatwootWebhookPath(conexaoId: string): string {
  return `/api/chatwoot/webhook/${conexaoId}`;
}

/**
 * URL do webhook do Chatwoot, ou `null` sem origem estável configurada.
 *
 * Mesmo desenho de `resolveBlingCallbackUrl`, e pela mesma razão: quem cola o
 * endereço numa configuração externa precisa de um host que não muda a cada
 * deploy. Um caminho relativo — o que a rota devolvia antes — não serve para
 * colar em lugar nenhum.
 */
export function resolveChatwootWebhookUrl(
  environment: AppBaseUrlEnvironment,
  conexaoId: string,
): string | null {
  const base = resolveAppBaseUrl(environment);
  return base._tag === 'AppBaseUrlResolved' ? `${base.origin}${chatwootWebhookPath(conexaoId)}` : null;
}
