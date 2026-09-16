/**
 * Transação OAuth de uso único (proteção CSRF do fluxo authorization_code).
 *
 * Fluxo:
 * 1. `authorize` cria a transação no banco, vinculada a ator e organização, e
 *    guarda apenas o hash SHA-256 do `state`;
 * 2. o `state` viaja pelo redirect do provedor; o id da transação vai num
 *    cookie `httpOnly` restrito a `/api/bling/callback`;
 * 3. o `callback` consome a transação com cookie + `state`. O consumo é um
 *    `UPDATE` condicional no banco: só vale uma vez e só antes de expirar.
 *
 * A organização que recebe os tokens vem da transação persistida, nunca de um
 * parâmetro do retorno do provedor.
 */
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';

import type { OAuthProvider, OAuthTransactionStorePort } from './oauthTransactionStore';
import type { VerifiedOrganizationScope } from './verifiedOrganizationScope';

/**
 * Janela para concluir a autorização no provedor.
 *
 * Uma primeira autorização real — entrar no Bling, passar por 2FA, escolher a
 * conta e ler a tela de permissões — pode levar vários minutos. 30 minutos
 * cobre essa jornada e continua curto para um token de uso único.
 */
export const OAUTH_TRANSACTION_TTL_MS = 30 * 60 * 1_000;

/**
 * O mesmo TTL, em segundos, para o cookie que acompanha a transação.
 *
 * Deriva da constante acima para que cookie e transação expirem juntos: um
 * cookie que expirasse antes faria o callback chegar sem ele enquanto a
 * transação no servidor ainda é válida.
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
 * Consome a transação comparando o hash do `state` recebido com o hash guardado.
 *
 * O consumo acontece num único `UPDATE` condicional (`consumir_transacao_oauth`):
 * id, hash, ainda não consumida e ainda não expirada. Um callback repetido
 * (mesmo cookie, mesmo `state`) encontra a linha já consumida e é negado, sem
 * disparar uma segunda troca de código por token.
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
