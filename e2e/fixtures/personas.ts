import { readFileSync } from 'node:fs';

import type {
  SeedManifest,
  SyntheticOrganization,
  SyntheticPersona,
} from '../../src/lib/e2e/syntheticSeedData';
import { findOrganization, findPersona } from '../../src/lib/e2e/syntheticSeedData';

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

/**
 * A organização sintética pela chave do manifesto.
 *
 * Existe para a spec não depender de `activeOrg` quando o que ela precisa é de
 * uma organização **específica**: a seleção ativa é estado do servidor, e outra
 * spec pode tê-la trocado. `findOrganization` falha alto se a chave não existir,
 * em vez de devolver algo aproximado.
 */
export function organizacao(manifest: SeedManifest, key: string): SyntheticOrganization {
  return findOrganization(manifest, key);
}
