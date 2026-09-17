/**
 * A regra de autorização do ORBITA: esta pessoa pode agir nesta organização?
 *
 * O ORBITA é multi-tenant: várias empresas (organizações) usam o mesmo sistema,
 * e os dados de uma não podem vazar para outra. O navegador pode mandar
 * qualquer `organizationId`, então esse id sozinho não prova nada — ele só diz
 * qual vínculo consultar.
 *
 * A decisão segue sempre a mesma ordem:
 * identidade confirmada → membership (vínculo persistido com a organização) →
 * papel (`owner`, `admin`, `member`) → capabilities (o que o papel permite) →
 * `OrganizationContext`.
 *
 * Este arquivo não conhece o Supabase: identidade e memberships chegam por
 * ports (interfaces), o que permite testar a regra sem banco. A ligação com o
 * Supabase fica em `requestOrganizationContext`.
 *
 * O `OrganizationContext` usa um símbolo privado ("brand") para que o
 * TypeScript só aceite contextos criados aqui. Isso ajuda o compilador a evitar
 * engano, mas não é segurança em tempo de execução: um cast explícito contorna.
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
  /**
   * Grava a organização ativa só se a versão esperada ainda for a atual (CAS),
   * numa única chamada ao banco que também confere o vínculo.
   */
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
 * O que cada papel pode fazer: a tabela papel → capability usada pelo servidor.
 *
 * `member` só acessa os dados (`organization:access`); `owner` e `admin`
 * também gerenciam (`organization:manage`). É daqui que o contexto de
 * autorização do servidor deriva as capabilities do papel, para que a regra
 * papel → permissão exista num único lugar.
 *
 * A interface usa a mesma regra só para mostrar ou esconder botões. Esconder um
 * botão não é autorização: quem decide é o servidor, na rota.
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
 * Junta identidade confirmada e vínculo persistido num `OrganizationContext`.
 *
 * A ordem importa: sem identidade não se consulta vínculo, e sem vínculo não há
 * capabilities. Não ter vínculo vira `OrganizationAccessDenied` (403); o banco
 * não responder vira `OrganizationStoreUnavailable` (503). Assim uma queda do
 * banco nunca aparece para a pessoa como "você não pertence a esta organização".
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
