/**
 * Pure generation logic for the E2E staging seed. Everything here is
 * deterministic given its inputs and has no I/O — the executable seed/cleanup
 * scripts under `e2e/seed/` import these builders and layer real Supabase
 * calls on top, which is why this module can be exercised by Vitest without a
 * staging environment.
 *
 * Every synthetic identifier (org slug, persona email) carries
 * `SYNTHETIC_DATA_PREFIX` plus a per-run id, so cleanup can always find and
 * remove exactly (and only) what a given run created — never a real
 * customer or user record.
 */

export const SYNTHETIC_DATA_PREFIX = 'orbita-e2e-';

/**
 * Sufixo do slug da organização que `organization.spec.ts` cria durante o teste.
 *
 * Mora aqui porque **duas** partes precisam do mesmo texto: a spec, que cria, e
 * o plano do seed, que a prevê para a limpeza alcançá-la. Dois literais
 * independentes deixariam o resíduo voltar numa renomeação, sem quebrar teste
 * nenhum.
 */
export const SUFIXO_ORG_CRIADA_PELA_SPEC = 'spec-created-org';

/** Slug completo da organização que a spec cria, para uma execução. */
export function slugDaOrganizacaoDaSpec(prefix: string): string {
  return `${prefix}${SUFIXO_ORG_CRIADA_PELA_SPEC}`;
}

export type SyntheticPersonaRole = 'owner' | 'admin' | 'member' | 'external';

export interface SyntheticOrganization {
  readonly key: string;
  readonly slug: string;
  readonly nome: string;
}

export interface SyntheticPersona {
  readonly key: string;
  readonly email: string;
  readonly password: string;
  readonly role: SyntheticPersonaRole;
  /**
   * The organization this persona belongs to, or `null` for the `external`
   * persona: per the E2E persona matrix ("owner de B e externo"), the external
   * persona is a real Supabase user who is a member of *no* organization,
   * used specifically to prove that a fully outside account never sees
   * either tenant's data.
   */
  readonly organizationKey: string | null;
  /**
   * The real Supabase auth user id, populated by `e2e/seed/run-seed.ts`
   * after it actually creates the user against staging. `buildSeedManifest`
   * never fabricates this — it stays absent until a real signup happened.
   */
  readonly userId?: string;
}

export interface SeedManifest {
  readonly runId: string;
  readonly createdAt: string;
  readonly prefix: string;
  readonly organizations: readonly SyntheticOrganization[];
  readonly personas: readonly SyntheticPersona[];
}

export interface BuildSeedManifestOptions {
  /** Fixes the run id for deterministic tests; a real run always omits this and gets a fresh one. */
  readonly runId?: string;
  /** Injectable clock for deterministic tests. */
  readonly clock?: () => Date;
  /** Injectable randomness source (0..1) for deterministic tests. */
  readonly random?: () => number;
}

function buildRunId(clock: () => Date, random: () => number): string {
  const iso = clock().toISOString().replace(/[^0-9]/g, '');
  const randomSuffix = Math.floor(random() * 36 ** 6)
    .toString(36)
    .padStart(6, '0');
  return `${iso}-${randomSuffix}`;
}

/** Deterministic-but-not-guessable synthetic password. Never a real credential. */
function buildSyntheticPassword(runId: string, personaKey: string): string {
  const compactRunId = runId.replace(/-/g, '').slice(0, 14);
  return `E2e!${compactRunId}-${personaKey}#9`;
}

/**
 * A organização em que a spec de convite convida — e o convidado que ela convida.
 *
 * O convite tem uma **organização própria** porque `org-a` já está cheia: o
 * seed a enche com exatamente três membros (`owner-a`, `admin-a`, `member-a`)
 * contra um limite de plano de três, e um convite ali é recusado com
 * `403 LIMIT_EXCEEDED` — corretamente — antes do aceite que a spec exercita.
 *
 * As alternativas custariam mais:
 *
 * - encolher `org-a` para dois membros custaria o `admin-a`, e com ele a matriz
 *   de papéis owner/admin/member que o seed existe para dar;
 * - aumentar o limite do plano faria a suíte exercitar um plano que talvez
 *   nenhum cliente use, e deixaria de testar o limite de entitlement;
 * - uma organização própria custa duas personas e uma linha de manifesto, e o
 *   executor do seed já é genérico o bastante para não mudar.
 *
 * **O convidado é dedicado, e sem vínculo nenhum.** Reaproveitar `member-a`
 * criaria um convite que ninguém precisa aceitar para virar membro — a spec
 * passaria sem provar o aceite. E reaproveitar `external` quebraria a premissa
 * do `cross-tenant-denial`, que existe justamente porque ele não é membro de
 * lugar nenhum: aceitar um convite o tornaria membro.
 */
export const ORGANIZACAO_DO_CONVITE = 'org-convite';

/** A persona convidada pela spec de organização. Sem vínculo, de propósito. */
export const PERSONA_CONVIDADA = 'convidado';

/**
 * Builds the full manifest of synthetic organizations and personas for one
 * E2E staging run: organizations A and B — with the owner/admin/member/
 * external-owner personas the minimum persona matrix requires for cross-tenant
 * and role-based denial specs — plus the invite organization, whose
 * only member is its owner so the invited guest has a seat.
 */
export function buildSeedManifest(options: BuildSeedManifestOptions = {}): SeedManifest {
  const clock = options.clock ?? (() => new Date());
  const random = options.random ?? Math.random;
  const runId = options.runId ?? buildRunId(clock, random);
  const prefix = `${SYNTHETIC_DATA_PREFIX}${runId}-`;

  const organizations: SyntheticOrganization[] = [
    { key: 'org-a', slug: `${prefix}org-a`, nome: `ORBITA E2E Org A ${runId}` },
    { key: 'org-b', slug: `${prefix}org-b`, nome: `ORBITA E2E Org B ${runId}` },
    {
      key: ORGANIZACAO_DO_CONVITE,
      slug: `${prefix}${ORGANIZACAO_DO_CONVITE}`,
      nome: `ORBITA E2E Org Convite ${runId}`,
    },
  ];

  const personaSpecs: ReadonlyArray<{ key: string; role: SyntheticPersonaRole; organizationKey: string | null }> = [
    { key: 'owner-a', role: 'owner', organizationKey: 'org-a' },
    { key: 'admin-a', role: 'admin', organizationKey: 'org-a' },
    { key: 'member-a', role: 'member', organizationKey: 'org-a' },
    { key: 'owner-b', role: 'owner', organizationKey: 'org-b' },
    { key: 'external', role: 'external', organizationKey: null },
    // A organização do convite, com **um** membro só: o limite do
    // Starter é 3, e é preciso sobrar vaga para quem aceitar o convite.
    { key: 'owner-convite', role: 'owner', organizationKey: ORGANIZACAO_DO_CONVITE },
    { key: PERSONA_CONVIDADA, role: 'external', organizationKey: null },
  ];

  const personas: SyntheticPersona[] = personaSpecs.map((spec) => ({
    key: spec.key,
    email: `${prefix}${spec.key}@e2e.orbita.test`,
    password: buildSyntheticPassword(runId, spec.key),
    role: spec.role,
    organizationKey: spec.organizationKey,
  }));

  return {
    runId,
    createdAt: clock().toISOString(),
    prefix,
    organizations,
    personas,
  };
}

/** Whether a slug/email/name was created by the synthetic seed (any run). */
export function isSyntheticIdentifier(value: string): boolean {
  return value.includes(SYNTHETIC_DATA_PREFIX);
}

/** Whether a slug/email/name belongs specifically to this manifest's run. */
export function isFromManifestRun(manifest: SeedManifest, value: string): boolean {
  return value.includes(manifest.prefix);
}

interface RecordWithSyntheticFields {
  readonly slug?: string;
  readonly email?: string;
  readonly nome?: string;
}

/**
 * Filters arbitrary records (e.g. rows read back from staging) down to the
 * ones the cleanup step is allowed to delete: only records carrying the
 * synthetic prefix in a slug, email, or name field ever qualify.
 */
export function filterSyntheticRecords<T extends RecordWithSyntheticFields>(records: readonly T[]): T[] {
  return records.filter(
    (record) =>
      (record.slug !== undefined && isSyntheticIdentifier(record.slug)) ||
      (record.email !== undefined && isSyntheticIdentifier(record.email)) ||
      (record.nome !== undefined && isSyntheticIdentifier(record.nome)),
  );
}

export function findOrganization(manifest: SeedManifest, key: string): SyntheticOrganization {
  const organization = manifest.organizations.find((org) => org.key === key);
  if (!organization) {
    throw new Error(`Organização sintética "${key}" não encontrada no manifest do run ${manifest.runId}.`);
  }
  return organization;
}

export function findPersona(manifest: SeedManifest, key: string): SyntheticPersona {
  const persona = manifest.personas.find((candidate) => candidate.key === key);
  if (!persona) {
    throw new Error(`Persona sintética "${key}" não encontrada no manifest do run ${manifest.runId}.`);
  }
  return persona;
}

/** Returns the real Supabase user id for a persona, or throws — never a fabricated fallback id. */
export function requirePersonaUserId(persona: SyntheticPersona): string {
  if (!persona.userId) {
    throw new Error(
      `Persona sintética "${persona.key}" ainda não tem userId real: rode e2e/seed/run-seed.ts contra ` +
        'staging antes de usar specs que dependem do id de usuário do Supabase.',
    );
  }
  return persona.userId;
}

/** Pure update: attaches the real Supabase user id to a persona after `run-seed.ts` creates it. */
export function withPersonaUserId(manifest: SeedManifest, personaKey: string, userId: string): SeedManifest {
  return {
    ...manifest,
    personas: manifest.personas.map((candidate) =>
      candidate.key === personaKey ? { ...candidate, userId } : candidate,
    ),
  };
}
