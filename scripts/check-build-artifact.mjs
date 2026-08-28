import fs from 'node:fs';
import path from 'node:path';

/**
 * Directory/file name fragments that must never ship inside the production
 * build artifact (development metadata, agent workspaces, secrets files).
 * Matched case-insensitively against every path segment.
 */
export const FORBIDDEN_NAME_FRAGMENTS = [
  '.env',
  '.agents',
  '.codex',
  '.scratch',
  'graphify-out',
];

/**
 * Non-public environment variable names that must never appear as literal
 * text inside client-servable assets (anything under `<artifact>/static`).
 * `NEXT_PUBLIC_*` variables are expected there and are not checked.
 */
export const FORBIDDEN_CLIENT_STRINGS = [
  'SUPABASE_SERVICE_ROLE_KEY',
  'BLING_CLIENT_SECRET',
  'BLING_WEBHOOK_SECRET',
  'BLING_API_KEY',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'CHATWOOT_API_TOKEN',
  'CHATWOOT_WEBHOOK_SECRET',
  'INTEGRATION_ENCRYPTION_KEY',
  'ENCRYPTION_KEY',
];

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.woff', '.woff2',
  '.ttf', '.otf', '.eot', '.pdf', '.zip', '.br', '.gz',
]);

function walk(dir, onFile) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, onFile);
    } else if (entry.isFile()) {
      onFile(fullPath);
    }
  }
}

/**
 * Scan a built artifact directory (e.g. `.next`) for development metadata
 * that must never ship, and for non-public secret variable names leaking
 * into client-servable assets.
 *
 * @param {string} artifactDir absolute path to the build output directory
 * @returns {{ valid: boolean, forbiddenPaths: string[], leakedClientStrings: Array<{file: string, matches: string[]}> }}
 */
export function checkBuildArtifact(artifactDir) {
  const forbiddenPaths = [];
  const leakedClientStrings = [];

  if (!fs.existsSync(artifactDir)) {
    return { valid: false, forbiddenPaths: [`artifact directory not found: ${artifactDir}`], leakedClientStrings: [] };
  }

  const clientDir = path.join(artifactDir, 'static');

  walk(artifactDir, (filePath) => {
    const relativePath = path.relative(artifactDir, filePath).replaceAll('\\', '/');
    const lowerPath = relativePath.toLowerCase();

    for (const fragment of FORBIDDEN_NAME_FRAGMENTS) {
      if (lowerPath.includes(fragment)) {
        forbiddenPaths.push(relativePath);
        break;
      }
    }

    if (filePath.startsWith(clientDir + path.sep)) {
      const ext = path.extname(filePath).toLowerCase();
      if (BINARY_EXTENSIONS.has(ext)) return;

      let content;
      try {
        content = fs.readFileSync(filePath, 'utf8');
      } catch {
        return;
      }

      const matches = FORBIDDEN_CLIENT_STRINGS.filter((needle) => content.includes(needle));
      if (matches.length > 0) {
        leakedClientStrings.push({ file: relativePath, matches });
      }
    }
  });

  return {
    valid: forbiddenPaths.length === 0 && leakedClientStrings.length === 0,
    forbiddenPaths: forbiddenPaths.sort(),
    leakedClientStrings,
  };
}

const isMainModule = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve('scripts/check-build-artifact.mjs');

if (isMainModule) {
  const artifactDir = path.resolve(process.argv[2] || '.next');
  const result = checkBuildArtifact(artifactDir);

  if (!result.valid) {
    console.error(`Build artifact allowlist check failed for ${artifactDir}:`);
    for (const forbidden of result.forbiddenPaths) {
      console.error(`- forbidden path shipped in artifact: ${forbidden}`);
    }
    for (const leak of result.leakedClientStrings) {
      console.error(`- non-public secret name leaked into client asset ${leak.file}: ${leak.matches.join(', ')}`);
    }
    process.exitCode = 1;
  } else {
    console.log(`Build artifact allowlist check passed for ${artifactDir}.`);
  }
}
