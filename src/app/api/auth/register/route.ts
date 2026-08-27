import { NextResponse } from 'next/server';
import { z } from 'zod';

import { checkRateLimit, normalizeIp, rateLimitDenialStatus, DEFAULT_RATE_LIMIT_POLICIES, type RateLimitStorePort } from '../../../../lib/rateLimit';
import { logger } from '../../../../lib/observability/logger';
import { getCorrelationId } from '../../../../lib/observability/correlation';

export const dynamic = 'force-dynamic';

const GENERIC_REGISTRATION_MESSAGE =
  'Se os dados informados forem válidos, você receberá um e-mail para confirmar seu cadastro.';

/** Outcome of the sign-up attempt, deliberately collapsing "already registered" into success. */
export type RegisterSignUpResult =
  | { readonly _tag: 'SignUpSucceeded' }
  | { readonly _tag: 'SignUpAlreadyRegistered' }
  | { readonly _tag: 'SignUpFailed'; readonly cause: string };

/** Explicit dependencies for the register handler; production wiring lives in `POST`. */
export interface RegisterDependencies {
  readonly signUp: (input: { email: string; password: string; name: string }) => Promise<RegisterSignUpResult>;
  readonly rateLimitStore: RateLimitStorePort;
}

interface ParsedRegisterInput {
  readonly email: string;
  readonly password: string;
  readonly name: string;
}

type RegisterInputParseResult =
  | { readonly ok: true; readonly value: ParsedRegisterInput }
  | { readonly ok: false; readonly error: string };

const presenceSchema = z.object({
  email: z.string().trim().min(1),
  password: z.string().min(1),
  name: z.string().trim().min(1),
});
const emailSchema = z.string().trim().toLowerCase().email();

/** Parse the untrusted registration body with Zod at the HTTP boundary. */
function parseRegisterInput(body: unknown): RegisterInputParseResult {
  const presence = presenceSchema.safeParse(body);
  if (!presence.success) {
    return { ok: false, error: 'E-mail, senha e nome são obrigatórios.' };
  }

  const email = emailSchema.safeParse(presence.data.email);
  if (!email.success) {
    return { ok: false, error: 'E-mail inválido.' };
  }

  if (presence.data.password.length < 6) {
    return { ok: false, error: 'A senha deve ter pelo menos 6 caracteres.' };
  }

  return { ok: true, value: { email: email.data, password: presence.data.password, name: presence.data.name } };
}

/** Build the registration handler around explicit rate-limit and identity-provider seams. */
export function createRegisterHandler(dependencies: RegisterDependencies) {
  return async function registerHandler(request: Request): Promise<NextResponse> {
    const correlationId = getCorrelationId(request);

    // Cheap structural validation runs before the rate limiter: a malformed
    // request is rejected without consuming a rate-limit slot or reaching the
    // durable store, keeping the limiter's capacity for well-formed attempts.
    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return NextResponse.json({ success: false, error: 'Corpo da requisição inválido.' }, { status: 400 });
    }

    const parsedInput = parseRegisterInput(rawBody);
    if (!parsedInput.ok) {
      return NextResponse.json({ success: false, error: parsedInput.error }, { status: 400 });
    }

    const rateLimitDecision = await checkRateLimit(
      dependencies.rateLimitStore,
      'register',
      normalizeIp(request),
      DEFAULT_RATE_LIMIT_POLICIES.register,
    );
    if (rateLimitDecision._tag !== 'RateLimitAllowed') {
      logger.warn('register.rate_limited', { subsystem: 'app', correlationId, tag: rateLimitDecision._tag });
      return NextResponse.json(
        { success: false, error: 'Muitas tentativas. Tente novamente mais tarde.' },
        { status: rateLimitDenialStatus(rateLimitDecision) },
      );
    }

    const result = await dependencies.signUp(parsedInput.value);

    if (result._tag === 'SignUpFailed') {
      logger.error('register.sign_up_failed', { subsystem: 'app', correlationId, cause: result.cause });
      return NextResponse.json(
        { success: false, error: 'Erro ao criar conta. Tente novamente mais tarde.' },
        { status: 500 },
      );
    }

    // SignUpSucceeded and SignUpAlreadyRegistered return the exact same public
    // response — same status, same message, no user data — so this boundary
    // never lets a caller enumerate which email addresses already have accounts.
    logger.info('register.attempt_completed', { subsystem: 'app', correlationId });
    return NextResponse.json({ success: true, message: GENERIC_REGISTRATION_MESSAGE });
  };
}

/** Production registration route. */
export async function POST(request: Request): Promise<NextResponse> {
  const { supabaseServer } = await import('../../../../lib/supabaseServer');
  const { createSupabaseRateLimitStore } = await import('../../../../lib/rateLimitStore');

  const handler = createRegisterHandler({
    rateLimitStore: createSupabaseRateLimitStore(supabaseServer),
    signUp: async ({ email, password, name }) => {
      // Cadastro padrão sem elevação indevida de privilégios ou auto-confirmação via service_role admin
      const { error } = await supabaseServer.auth.signUp({
        email,
        password,
        options: { data: { full_name: name } },
      });

      if (!error) {
        return { _tag: 'SignUpSucceeded' };
      }
      if (error.message.toLowerCase().includes('already registered')) {
        return { _tag: 'SignUpAlreadyRegistered' };
      }
      return { _tag: 'SignUpFailed', cause: error.name ?? 'unknown_signup_error' };
    },
  });

  return handler(request);
}
