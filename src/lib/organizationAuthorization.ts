/**
 * Autoriza operações dentro de uma organização do ORBITA (núcleo puro).
 *
 * Fluxo: identidade → membership persistida → papel → capabilities → contexto.
 *
 * O identificador de organização enviado pelo navegador não concede autoridade:
 * ele só escolhe qual vínculo consultar. O contexto resultante carrega um
 * símbolo privado: no sistema de tipos, só este módulo o constrói (sem um cast
 * explícito). É uma proteção de compilação, não de runtime — quem recebe um
 * `OrganizationContext` construído normalmente sabe que ator e organização
 * já foram comprovados.
 *
 * Não conhece Supabase: identidade e memberships entram por portas
 * (`OrganizationAuthorizationDependencies`), o que permite testar a regra sem
 * banco. O adaptador de produção está em `requestOrganizationContext`.
 */
import { z } from 'zod';

import {
  resolveAuthenticatedIdentity,
  type AuthenticatedIdentityResult,
  type AuthenticatedUser,
} from './auth';
import type { Organizacao, PapelMembro } from './organizationContext';

const actorIdSchema = z.string().uuid().brand<'OrganizationActorId'>();
const organizationIdSchema = z.string().uuid().brand<'OrganizationId'>();
const contextBrand: unique symbol = Symbol('CanonicalOrganizationContext');

/** UUID brand for organization actors. */
export type OrganizationActorId = z.infer<typeof actorIdSchema>;

/** UUID brand for organizations. */
export type OrganizationId = z.infer<typeof organizationIdSchema>;

/**
 * Qual vínculo consultar.
 *
 * `FirstMembership` significa "a organização ativa persistida do ator"; sem
 * seleção persistida, o adaptador usa o vínculo mais antigo. `ExactOrganization`
 * pede um par ator/organização específico e falha se ele não existir.
 */
export type OrganizationSelection =
  | { readonly _tag: 'FirstMembership' }
  | { readonly _tag: 'ExactOrganization'; readonly organizationId: OrganizationId };

/** Persisted membership returned by an authorization adapter. */
export interface PersistedOrganizationMembership {
  readonly actorId: OrganizationActorId;
  readonly organizationId: OrganizationId;
  readonly role: PapelMembro;
  readonly organization: Organizacao;
  readonly selectionVersion: number;
}

/** Typed result of looking up one persisted membership. */
export type MembershipLookupResult =
  | { readonly _tag: 'MembershipFound'; readonly membership: PersistedOrganizationMembership }
  | { readonly _tag: 'MembershipNotFound' }
  | { readonly _tag: 'MembershipStoreUnavailable'; readonly cause: string };

/**
 * Resultado da troca da organização ativa por compare-and-swap (CAS).
 *
 * `Stale` quer dizer que a versão esperada não é a atual — outra aba ou
 * requisição já trocou a seleção, ou, com versão esperada `0`, já existe uma
 * seleção. Em nenhum dos casos a troca é aplicada por cima.
 */
export type OrganizationSwitchResult =
  | { readonly _tag: 'OrganizationSwitchApplied'; readonly version: number }
  | { readonly _tag: 'OrganizationSwitchStale' }
  | { readonly _tag: 'OrganizationSwitchDenied' }
  | { readonly _tag: 'MembershipStoreUnavailable'; readonly cause: string };

/** Application-owned capability required from organization persistence. */
export interface OrganizationMembershipPort {
  /** Find the first membership or an exact actor/organization membership. */
  readonly findMembership: (
    actorId: OrganizationActorId,
    selection: OrganizationSelection,
  ) => Promise<MembershipLookupResult>;
  /** Atomically persist an authorized active organization using compare-and-swap. */
  readonly switchActiveOrganization: (
    actorId: OrganizationActorId,
    organizationId: OrganizationId,
    expectedVersion: number,
  ) => Promise<OrganizationSwitchResult>;
}

/** Authorization capability derived from a persisted organization role. */
export type OrganizationCapability = 'organization:access' | 'organization:manage';

/** Canonical actor, organization, role and capabilities proven server-side. */
export interface OrganizationContext {
  readonly actorId: OrganizationActorId;
  readonly user: AuthenticatedUser;
  readonly organizationId: OrganizationId;
  readonly organization: Organizacao;
  readonly role: PapelMembro;
  readonly capabilities: ReadonlySet<OrganizationCapability>;
  readonly selectionVersion: number;
  readonly [contextBrand]: true;
}

/** Tagged outcome of resolving canonical organization authority. */
export type OrganizationContextResult =
  | { readonly _tag: 'OrganizationContextResolved'; readonly context: OrganizationContext }
  | Exclude<AuthenticatedIdentityResult, { readonly _tag: 'IdentityVerified' }>
  | { readonly _tag: 'OrganizationAccessDenied' }
  | { readonly _tag: 'OrganizationStoreUnavailable'; readonly cause: string };

/** Identity and membership dependencies. */
export interface OrganizationAuthorizationDependencies {
  readonly verifyIdentity: (request: Request) => Promise<AuthenticatedIdentityResult>;
  readonly memberships: OrganizationMembershipPort;
}

/**
 * Capabilities concedidas por um papel persistido — a tabela papel → permissão
 * das fronteiras do servidor.
 *
 * `member` só acessa; `owner` e `admin` também gerenciam. Rotas que autorizam
 * uma organização nomeada na URL usam esta mesma função, para que nenhuma
 * fronteira do servidor redecida por conta própria o que um papel pode fazer.
 * A interface repete a regra apenas para exibir ou esconder ações; isso não
 * concede acesso.
 */
export function organizationCapabilitiesForRole(role: PapelMembro): ReadonlySet<OrganizationCapability> {
  return role === 'member'
    ? new Set(['organization:access'])
    : new Set(['organization:access', 'organization:manage']);
}

/** Parse an untrusted organization identifier into the authorization domain. */
export function parseOrganizationId(input: string): OrganizationId | null {
  const result = organizationIdSchema.safeParse(input);
  return result.success ? result.data : null;
}

/** Parse an untrusted actor identifier into the organization authorization domain. */
export function parseOrganizationActorId(input: string): OrganizationActorId | null {
  const result = actorIdSchema.safeParse(input);
  return result.success ? result.data : null;
}

/** Select the persisted active organization; request cookies never carry authority. */
export function activeOrganizationSelection(): OrganizationSelection {
  return { _tag: 'FirstMembership' };
}

/**
 * Transforma identidade verificada + membership persistida em contexto canônico.
 *
 * A ordem importa: sem identidade não se consulta vínculo, e sem vínculo não se
 * derivam capabilities. Ausência de vínculo vira `OrganizationAccessDenied`
 * (403); falha do banco vira `OrganizationStoreUnavailable` (503) — uma
 * indisponibilidade nunca é confundida com "você não pertence a esta organização".
 */
export async function resolveOrganizationContext(
  request: Request,
  selection: OrganizationSelection | null,
  dependencies: OrganizationAuthorizationDependencies,
): Promise<OrganizationContextResult> {
  if (!selection) return { _tag: 'OrganizationAccessDenied' };
  const identity = await dependencies.verifyIdentity(request);
  if (identity._tag !== 'IdentityVerified') return identity;

  const actorId = actorIdSchema.safeParse(identity.user.id);
  if (!actorId.success) return { _tag: 'OrganizationAccessDenied' };

  const lookup = await dependencies.memberships.findMembership(actorId.data, selection);
  if (lookup._tag === 'MembershipNotFound') return { _tag: 'OrganizationAccessDenied' };
  if (lookup._tag === 'MembershipStoreUnavailable') {
    return { _tag: 'OrganizationStoreUnavailable', cause: lookup.cause };
  }

  const { membership } = lookup;
  return {
    _tag: 'OrganizationContextResolved',
    context: {
      actorId: membership.actorId,
      user: identity.user,
      organizationId: membership.organizationId,
      organization: membership.organization,
      role: membership.role,
      capabilities: organizationCapabilitiesForRole(membership.role),
      selectionVersion: membership.selectionVersion,
      [contextBrand]: true,
    },
  };
}

/** Translate a canonical authorization failure into a safe HTTP status. */
export function organizationContextStatus(
  result: Exclude<OrganizationContextResult, { readonly _tag: 'OrganizationContextResolved' }>,
): 401 | 403 | 503 {
  if (result._tag === 'IdentityProviderUnavailable' || result._tag === 'OrganizationStoreUnavailable') return 503;
  if (result._tag === 'SessionMissing' || result._tag === 'SessionInvalid') return 401;
  return 403;
}

/** Verify request identity with the configured provider. */
export const verifyRequestIdentity = resolveAuthenticatedIdentity;
