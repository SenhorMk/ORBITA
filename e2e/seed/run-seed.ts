/**
 * Real, executable seed script for ticket 24's E2E staging run. NOT run as
 * part of any gate or CI step in this ticket — it requires a real staging
 * Supabase project, which does not exist yet (ticket 23 is `needs-owner`).
 * It is included so the moment staging exists, seeding is `npm run
 * e2e:seed` away, and so its pure data-shape logic
 * (`src/lib/e2e/syntheticSeedData.ts`) is already covered by Vitest today.
 *
 * What it does, end to end:
 * 1. Validates the environment is staging (fail-closed, same rules as
 *    `playwright.config.ts`).
 * 2. Builds a fresh manifest of two synthetic organizations and five
 *    personas (owner/admin/member of org A, owner of org B, one fully
 *    external user).
 * 3. Creates each persona as a real Supabase auth user (service role,
 *    `auth.admin.createUser`, pre-confirmed so login works immediately).
 * 4. Creates the two organizations and memberships directly (service role
 *    intentionally bypasses RLS here — this is an operational seeding tool,
 *    not application runtime logic serving a tenant request).
 * 5. Writes the manifest (with real Supabase user ids attached) to disk so
 *    Playwright specs and `run-cleanup.ts` can find exactly what this run
 *    created.
 *
 * Usage once staging exists:
 *   STAGING_URL=https://staging.orbita.example.com \
 *   SUPABASE_URL=https://orbita-staging.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=... \
 *   npm run e2e:seed
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { resolveStagingConfig } from '../../src/lib/e2e/stagingConfig';
import {
  buildSeedManifest,
  findOrganization,
  withPersonaUserId,
  type SeedManifest,
  type SyntheticPersonaRole,
} from '../../src/lib/e2e/syntheticSeedData';

const MEMBER_ROLE_BY_PERSONA_ROLE: Record<Exclude<SyntheticPersonaRole, 'external'>, 'owner' | 'admin' | 'member'> = {
  owner: 'owner',
  admin: 'admin',
  member: 'member',
};

async function createPersonaUser(
  supabase: SupabaseClient,
  email: string,
  password: string,
): Promise<string> {
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) {
    throw new Error(`Falha ao criar usuário sintético "${email}": ${error?.message ?? 'sem detalhe'}.`);
  }
  return data.user.id;
}

async function createOrganizationRow(
  supabase: SupabaseClient,
  slug: string,
  nome: string,
): Promise<string> {
  const { data, error } = await supabase
    .from('organizacoes')
    .insert({ slug, nome, status: 'active' })
    .select('id')
    .single();
  if (error || !data) {
    throw new Error(`Falha ao criar organização sintética "${slug}": ${error?.message ?? 'sem detalhe'}.`);
  }
  return (data as { id: string }).id;
}

async function insertMembership(
  supabase: SupabaseClient,
  organizacaoId: string,
  userId: string,
  papel: 'owner' | 'admin' | 'member',
): Promise<void> {
  const { error } = await supabase
    .from('membros_organizacao')
    .insert({ organizacao_id: organizacaoId, user_id: userId, papel });
  if (error) {
    throw new Error(`Falha ao criar membership sintética (org ${organizacaoId}, user ${userId}): ${error.message}.`);
  }
}

async function seedStaging(): Promise<SeedManifest> {
  const stagingConfig = resolveStagingConfig(process.env);
  if (!stagingConfig.supabaseUrl) {
    throw new Error('SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL de staging é obrigatória para rodar o seed.');
  }
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!serviceRoleKey) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY é obrigatória para rodar o seed (fail-closed, sem fallback).');
  }

  const supabase = createClient(stagingConfig.supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let manifest = buildSeedManifest();

  const organizationRealIds = new Map<string, string>();
  for (const organization of manifest.organizations) {
    const realId = await createOrganizationRow(supabase, organization.slug, organization.nome);
    organizationRealIds.set(organization.key, realId);
  }

  for (const personaEntry of manifest.personas) {
    const userId = await createPersonaUser(supabase, personaEntry.email, personaEntry.password);
    manifest = withPersonaUserId(manifest, personaEntry.key, userId);

    if (personaEntry.organizationKey !== null && personaEntry.role !== 'external') {
      const organization = findOrganization(manifest, personaEntry.organizationKey);
      const organizacaoId = organizationRealIds.get(organization.key);
      if (!organizacaoId) {
        throw new Error(`Organização real não resolvida para a chave "${organization.key}".`);
      }
      await insertMembership(supabase, organizacaoId, userId, MEMBER_ROLE_BY_PERSONA_ROLE[personaEntry.role]);
    }
  }

  return manifest;
}

async function main(): Promise<void> {
  const manifest = await seedStaging();
  const manifestPath = resolve(process.cwd(), `e2e/.manifests/${manifest.runId}.json`);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

  process.stdout.write(
    `Seed concluído: run ${manifest.runId}, ${manifest.organizations.length} organizações, ` +
      `${manifest.personas.length} personas. Manifest: ${manifestPath}\n` +
      `Defina E2E_SEED_MANIFEST_PATH=${manifestPath} antes de rodar \`npm run e2e\`.\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`Falha no seed de staging: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
