import { readBearerToken } from './bearer-token';

import type { User } from '@supabase/supabase-js';

/** Minimal identity-provider capability required to authenticate a request. */
export type AuthUserLookup = {
  readonly getUser: (token: string) => Promise<{
    readonly data: { readonly user: User | null };
    readonly error: { readonly message: string } | null;
  }>;
};

const defaultAuthUserLookup: AuthUserLookup = {
  async getUser(token) {
    const { supabaseServer } = await import('./supabaseServer');
    return supabaseServer.auth.getUser(token);
  },
};

export interface AuthSession {
  user: User;
  role: 'dono' | 'colaborador';
}

/**
 * Valida o token JWT do Supabase e retorna o usuário e sua role.
 * Aceita credenciais exclusivamente pelo header Authorization.
 */
export async function verifySessionAndRole(
  request: Request,
  authUserLookup: AuthUserLookup = defaultAuthUserLookup,
): Promise<AuthSession | null> {
  const bearerResult = readBearerToken(request);
  if (bearerResult._tag === 'BearerTokenMissing') {
    console.warn('[auth] Nenhum token encontrado na requisição');
    return null;
  }

  if (bearerResult._tag === 'DevelopmentTokenRejected') {
    console.warn('[auth] Token de desenvolvimento rejeitado');
    return null;
  }

  const token = bearerResult.token;

  try {
    const { data: { user }, error } = await authUserLookup.getUser(token);
    if (error) {
      console.error('[auth] Erro ao validar JWT:', error.message);
      return null;
    }
    if (user) {
      const role = user.app_metadata?.role === 'dono' ? 'dono' : 'colaborador';
      console.info('[auth] Usuário validado com sucesso.', { role });
      return { user, role };
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Falha desconhecida';
    console.error('[auth] Exceção ao validar JWT:', message);
  }

  return null;
}
