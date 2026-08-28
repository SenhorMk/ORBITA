/**
 * Real, executable cleanup script paired with `run-seed.ts`. Reads back the
 * manifest a seed run wrote, re-reads the corresponding rows from staging,
 * filters them down with `filterSyntheticRecords` (prefix-based, never a
 * broad delete), and removes exactly those rows plus their auth users.
 *
 * Not run as part of any gate in this ticket — same staging dependency as
 * `run-seed.ts`.
 *
 * Usage once staging exists:
 *   STAGING_URL=... SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *   npm run e2e:cleanup -- e2e/.manifests/<runId>.json
 */
import { readFileSync } from 'node:fs';

import { createClient } from '@supabase/supabase-js';

import { resolveStagingConfig } from '../../src/lib/e2e/stagingConfig';
import { filterSyntheticRecords, type SeedManifest } from '../../src/lib/e2e/syntheticSeedData';

function loadManifestFromArgv(): SeedManifest {
  const manifestPath = process.argv[2];
  if (!manifestPath) {
    throw new Error('Uso: npm run e2e:cleanup -- <caminho-do-manifest.json>');
  }
  return JSON.parse(readFileSync(manifestPath, 'utf8')) as SeedManifest;
}

async function cleanupStaging(manifest: SeedManifest): Promise<void> {
  const stagingConfig = resolveStagingConfig(process.env);
  if (!stagingConfig.supabaseUrl) {
    throw new Error('SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL de staging é obrigatória para rodar o cleanup.');
  }
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!serviceRoleKey) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY é obrigatória para rodar o cleanup (fail-closed, sem fallback).');
  }

  const supabase = createClient(stagingConfig.supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: organizationRows, error: organizationsError } = await supabase
    .from('organizacoes')
    .select('id, slug, nome')
    .ilike('slug', `${manifest.prefix}%`);
  if (organizationsError) {
    throw new Error(`Falha ao ler organizações sintéticas para cleanup: ${organizationsError.message}.`);
  }

  const syntheticOrganizations = filterSyntheticRecords(
    (organizationRows ?? []) as Array<{ id: string; slug: string; nome: string }>,
  );

  for (const organization of syntheticOrganizations) {
    const { error: deleteMembershipsError } = await supabase
      .from('membros_organizacao')
      .delete()
      .eq('organizacao_id', organization.id);
    if (deleteMembershipsError) {
      throw new Error(
        `Falha ao remover memberships da organização sintética ${organization.slug}: ${deleteMembershipsError.message}.`,
      );
    }

    const { error: deleteOrgError } = await supabase.from('organizacoes').delete().eq('id', organization.id);
    if (deleteOrgError) {
      throw new Error(`Falha ao remover organização sintética ${organization.slug}: ${deleteOrgError.message}.`);
    }
  }

  for (const personaEntry of manifest.personas) {
    if (!personaEntry.userId) continue;
    const { error: deleteUserError } = await supabase.auth.admin.deleteUser(personaEntry.userId);
    if (deleteUserError) {
      throw new Error(`Falha ao remover usuário sintético ${personaEntry.email}: ${deleteUserError.message}.`);
    }
  }

  process.stdout.write(
    `Cleanup concluído para o run ${manifest.runId}: ${syntheticOrganizations.length} organizações e ` +
      `${manifest.personas.length} personas removidas.\n`,
  );
}

cleanupStaging(loadManifestFromArgv()).catch((error: unknown) => {
  process.stderr.write(`Falha no cleanup de staging: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
