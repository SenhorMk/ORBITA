import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { readSupabaseBrowserConfiguration, type InvalidRuntimeConfiguration } from './runtime-config';

/**
 * Result of building a Supabase client bound to one verified end-user session.
 *
 * Construction can only fail on missing/invalid public Supabase configuration,
 * which is a deployment fault rather than a caller fault, so the failure is a
 * value the boundary maps to `503` instead of an exception.
 */
export type ActorScopedSupabaseClientResult =
  | { readonly _tag: 'ActorScopedClientCreated'; readonly client: SupabaseClient }
  | { readonly _tag: 'ActorScopedClientUnavailable'; readonly variable: InvalidRuntimeConfiguration['variable'] };

/**
 * Build a Supabase client that executes statements as the authenticated user.
 *
 * Several `security definer` RPCs (`criar_organizacao_atomica`,
 * `criar_convite_organizacao`, `aceitar_convite_organizacao`,
 * `revogar_membro_organizacao`) identify and authorize the actor with
 * `auth.uid()`. `auth.uid()` is derived from the request's JWT, so the
 * `service_role` key — which carries no user subject — makes them fail closed.
 * Those calls must travel on the anon key plus the caller's own access token,
 * which keeps RLS and the function's self-authorization in force instead of
 * bypassing them.
 *
 * The token must already have been verified against the identity provider
 * (`resolveAuthenticatedIdentity`); this adapter only transports it.
 *
 * @param accessToken - The verified bearer access token of the acting user.
 * @param environment - Runtime environment to read public Supabase configuration from.
 * @returns The actor-scoped client, or a tagged configuration failure.
 */
export function createActorScopedSupabaseClient(
  accessToken: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ActorScopedSupabaseClientResult {
  const configuration = readSupabaseBrowserConfiguration(environment);
  if (configuration._tag === 'InvalidRuntimeConfiguration') {
    return { _tag: 'ActorScopedClientUnavailable', variable: configuration.variable };
  }

  const client = createClient(configuration.url, configuration.anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  });

  return { _tag: 'ActorScopedClientCreated', client };
}
