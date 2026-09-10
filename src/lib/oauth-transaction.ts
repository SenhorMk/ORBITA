import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';

import type { OAuthProvider, OAuthTransactionStorePort } from './oauthTransactionStore';
import type { VerifiedOrganizationScope } from './verifiedOrganizationScope';

/**
 * Janela para concluir a autorizacao no provedor.
 *
 * Eram 10 minutos, que nao cobrem uma primeira autorizacao real: entrar no
 * Bling, passar por 2FA, escolher a conta e ler a tela de permissoes leva mais
 * que isso, e o resultado era "transacao ausente" sem explicacao. 30 minutos
 * continua curto para um token de uso unico e cabe na jornada de verdade.
 */
export const OAUTH_TRANSACTION_TTL_MS = 30 * 60 * 1_000;

/**
 * O mesmo TTL, em segundos, para o cookie que acompanha a transacao.
 *
 * Exportado porque o cookie era fixado em 600s enquanto a transacao no
 * servidor valia 1800s: entre 10 e 30 minutos o navegador ja tinha descartado
 * o cookie, o callback chegava sem ele, e a tela dizia "a sessao de conexao
 * nao chegou" para uma transacao que continuava valida. Duas constantes para
 * o mesmo prazo divergem; esta e a unica.
 */
export const OAUTH_TRANSACTION_TTL_SECONDS = OAUTH_TRANSACTION_TTL_MS / 1_000;
const cookieValueSchema = z.uuid();

/** Protected data returned to the caller after creating a pending OAuth transaction. */
export type OAuthTransaction = {
  readonly _tag: 'OAuthTransactionCreated';
  readonly state: string;
  readonly cookieValue: string;
};

/** Typed outcome of creating a protected OAuth transaction. */
export type OAuthTransactionCreationResult =
  | OAuthTransaction
  | {
      readonly _tag: 'OAuthTransactionCreationFailed';
      readonly reason: 'store-unavailable';
      readonly cause: string;
    };

/** Result of validating and atomically consuming a pending Bling OAuth transaction. */
export type OAuthTransactionConsumeResult =
  | {
      readonly _tag: 'ValidOAuthTransaction';
      readonly userId: string;
      readonly organizacaoId?: string;
    }
  | {
      readonly _tag: 'InvalidOAuthTransaction';
      readonly reason: 'malformed' | 'expired' | 'state-mismatch' | 'store-unavailable';
    };

function hashState(state: string): string {
  return createHash('sha256').update(state, 'utf8').digest('hex');
}

/**
 * Create a server-side, single-use OAuth transaction. The returned `cookieValue`
 * is an opaque reference (the store row id) — it carries no secret, actor,
 * organization or provider data by itself. The `state` travels through the
 * provider redirect and must match the stored hash on the way back.
 */
export async function createOAuthTransaction(
  actorId: string,
  organizacaoId: string | undefined,
  provider: OAuthProvider,
  store: OAuthTransactionStorePort,
  now: number = Date.now(),
): Promise<OAuthTransactionCreationResult> {
  // Hexadecimal, nao base64url: o `state` atravessa o redirect do provedor, e
  // a documentacao do Bling o exemplifica como uma sequencia hexadecimal. Um
  // valor com `-` e `_` depende de o provedor preservar esses caracteres — uma
  // variavel a menos, sem perder os 128 bits de entropia que o CSRF exige.
  const state = randomBytes(16).toString('hex');
  const result = await store.create({
    actorId,
    organizacaoId,
    provider,
    stateHash: hashState(state),
    expiresAt: now + OAUTH_TRANSACTION_TTL_MS,
  });

  if (result._tag === 'OAuthTransactionStoreUnavailable') {
    return { _tag: 'OAuthTransactionCreationFailed', reason: 'store-unavailable', cause: result.cause };
  }

  return { _tag: 'OAuthTransactionCreated', state, cookieValue: result.id };
}

/** Create an OAuth transaction from a nominally verified organization scope. */
export function createScopedOAuthTransaction(
  scope: VerifiedOrganizationScope,
  store: OAuthTransactionStorePort,
  now: number = Date.now(),
): Promise<OAuthTransactionCreationResult> {
  return createOAuthTransaction(scope.actorId, scope.organizationId, 'bling', store, now);
}

/**
 * Validate the received state in constant time against its stored hash and
 * atomically consume the transaction so a replayed callback (same cookie,
 * same state) can never succeed twice or trigger a second token exchange.
 */
export async function consumeOAuthTransaction(
  cookieValue: string,
  receivedState: string,
  store: OAuthTransactionStorePort,
  now: number = Date.now(),
): Promise<OAuthTransactionConsumeResult> {
  const idResult = cookieValueSchema.safeParse(cookieValue);
  if (!idResult.success || receivedState.length === 0) {
    return { _tag: 'InvalidOAuthTransaction', reason: 'malformed' };
  }

  const result = await store.consume(idResult.data, hashState(receivedState), now);

  if (result._tag === 'OAuthTransactionStoreUnavailable') {
    return { _tag: 'InvalidOAuthTransaction', reason: 'store-unavailable' };
  }
  if (result._tag === 'OAuthTransactionConsumeDenied') {
    // The store does not distinguish expired/mismatched/already-consumed rows in
    // its return value (all deny consumption identically), which is itself the
    // replay- and enumeration-resistant behavior this boundary requires.
    return { _tag: 'InvalidOAuthTransaction', reason: 'state-mismatch' };
  }

  return {
    _tag: 'ValidOAuthTransaction',
    userId: result.actorId,
    ...(result.organizacaoId ? { organizacaoId: result.organizacaoId } : {}),
  };
}
