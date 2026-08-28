import { readFileSync } from 'node:fs';

import type { SeedManifest, SyntheticPersona } from '../../src/lib/e2e/syntheticSeedData';
import { findPersona } from '../../src/lib/e2e/syntheticSeedData';

/**
 * Loads the seed manifest a previous `npm run e2e:seed` run wrote to disk
 * (see `e2e/seed/run-seed.ts`). Specs never invent credentials or fall back
 * to a hardcoded persona: if the manifest is missing, that is a hard
 * failure telling the operator to seed staging first, not a signal to make
 * something up.
 */
export function loadSeedManifest(manifestPath = process.env.E2E_SEED_MANIFEST_PATH): SeedManifest {
  if (!manifestPath) {
    throw new Error(
      'E2E_SEED_MANIFEST_PATH não definida. Rode `npm run e2e:seed` contra o STAGING_URL/SUPABASE_URL alvo ' +
        'primeiro; as specs nunca inventam credenciais de persona.',
    );
  }
  const raw = readFileSync(manifestPath, 'utf8');
  return JSON.parse(raw) as SeedManifest;
}

export function persona(manifest: SeedManifest, key: string): SyntheticPersona {
  return findPersona(manifest, key);
}
