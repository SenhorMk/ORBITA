/**
 * titularVerificationService.ts
 * Ticket 17: verificação técnica de identidade/autoridade do solicitante.
 *
 * Duas provas de identidade, nenhuma delas o campo de e-mail/documento
 * informado no formulário sozinho:
 *   - `lojista_user`: sessão forte já autenticada (`resolveAuthenticatedIdentity`
 *     em `src/lib/auth.ts`) somada a `actorId === titularRefUserId` (a sessão
 *     só prova identidade de si mesma, nunca de terceiros);
 *   - `cliente_final`: duas provas de conhecimento independentes amarradas a
 *     um registro real — e-mail/telefone batendo com `clientes` MAIS um
 *     código de verificação de uso único, com expiração e limite de
 *     tentativas, entregue apenas ao contato já cadastrado (nunca ao valor
 *     informado no formulário). Ver `docs/adr/ticket-17-direitos-titular.md`
 *     seção 1 para o que fica `needs-owner` (canal de entrega do código).
 */

import crypto from 'node:crypto';

export type LojistaSessionVerificationResult =
  | { readonly _tag: 'Verified'; readonly verifiedBy: string }
  | { readonly _tag: 'Impersonation' }
  | { readonly _tag: 'SessionInvalid' };

/**
 * Verifica que a sessão autenticada é a titular da própria solicitação — a
 * sessão nunca prova identidade de outra pessoa, mesmo que o `actorId` seja
 * um `owner`/`admin` da organização. Um operador autoriza/executa a
 * *solicitação* de outra pessoa (via `organization:manage`); ele nunca
 * "verifica-se" como sendo o titular de terceiros.
 */
export function verifyLojistaSession(input: {
  readonly authenticatedActorId: string | null | undefined;
  readonly titularRefUserId: string;
}): LojistaSessionVerificationResult {
  if (!input.authenticatedActorId || input.authenticatedActorId.trim().length === 0) {
    return { _tag: 'SessionInvalid' };
  }
  if (input.authenticatedActorId !== input.titularRefUserId) {
    return { _tag: 'Impersonation' };
  }
  return { _tag: 'Verified', verifiedBy: input.authenticatedActorId };
}

const CODE_ALPHABET_LENGTH = 1_000_000; // 6 dígitos numéricos

/** Gera um código de verificação de 6 dígitos com RNG criptográfico
 * (nunca `Math.random`). Nunca retornado em log — apenas para envio ao
 * canal já cadastrado do titular. */
export function generateVerificationCode(): string {
  const value = crypto.randomInt(0, CODE_ALPHABET_LENGTH);
  return value.toString().padStart(6, '0');
}

/** Hash do código para persistência — nunca grava o código em texto plano. */
export function hashVerificationCode(code: string): string {
  return crypto.createHash('sha256').update(code.trim()).digest('hex');
}

export type ClienteFinalVerificationResult =
  | { readonly _tag: 'Verified' }
  | { readonly _tag: 'CodeMissing' }
  | { readonly _tag: 'CodeMismatch' }
  | { readonly _tag: 'AttemptsExceeded' }
  | { readonly _tag: 'ChallengeExpired' };

export interface ClienteFinalVerificationInput {
  /** Código informado pelo solicitante nesta tentativa. `null`/vazio cobre o
   * caso "só informou e-mail/documento, sem código" — sempre rejeitado. */
  readonly submittedCode: string | null | undefined;
  readonly storedCodeHash: string;
  readonly expiresAt: Date;
  readonly now: Date;
  readonly attemptsSoFar: number;
  readonly maxAttempts: number;
}

/**
 * Verifica o desafio de `cliente_final`. Nunca aceita apenas e-mail/CPF: o
 * chamador só invoca esta função depois de já ter confirmado que o
 * e-mail/telefone informado bate com o cadastro (`clientes`), e mesmo assim
 * o código de uso único continua sendo exigido — a correspondência de
 * e-mail sozinha nunca retorna `Verified`.
 */
export function verifyClienteFinalChallenge(input: ClienteFinalVerificationInput): ClienteFinalVerificationResult {
  if (!input.submittedCode || input.submittedCode.trim().length === 0) {
    return { _tag: 'CodeMissing' };
  }
  if (input.attemptsSoFar >= input.maxAttempts) {
    return { _tag: 'AttemptsExceeded' };
  }
  if (input.now.getTime() > input.expiresAt.getTime()) {
    return { _tag: 'ChallengeExpired' };
  }
  const submittedHash = hashVerificationCode(input.submittedCode);
  const submittedBuffer = Buffer.from(submittedHash, 'hex');
  const storedBuffer = Buffer.from(input.storedCodeHash, 'hex');
  const matches =
    submittedBuffer.length === storedBuffer.length && crypto.timingSafeEqual(submittedBuffer, storedBuffer);
  if (!matches) {
    return { _tag: 'CodeMismatch' };
  }
  return { _tag: 'Verified' };
}

/** Janela padrão do desafio de verificação — needs-owner se o SLA jurídico
 * exigir outro valor (ver ADR seção "Lacunas jurídicas", item 5). */
export const VERIFICATION_CHALLENGE_TTL_MINUTES = 30;
