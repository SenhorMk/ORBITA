import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { collectAislopDiagnosticCounts } from './aislop-ratchet.mjs';

// Zero-tolerance AI-slop gate (ticket 20): there is no anonymous
// baseline/ratchet snapshot and no global ceiling. Every diagnostic must
// either be fixed for real, or be listed individually in
// quality/aislop-allowlist.json with an owner, a follow-up ticket, and a
// date (see that file's `description`). Any diagnostic not in the allowlist
// fails the build. `severity: "info"` diagnostics never fail the build —
// they are advisory (e.g. environment limitations), not code defects.
const repositoryRoot = process.cwd();
const allowlistPath = join(repositoryRoot, 'quality/aislop-allowlist.json');

const scan = spawnSync(
  process.execPath,
  [join(repositoryRoot, 'node_modules/aislop/dist/cli.js'), 'scan', '.', '--json'],
  { cwd: repositoryRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
);

if (!scan.stdout) {
  console.error('AI slop check could not read scan results.');
  console.error(scan.stderr || '(no stderr captured)');
  process.exitCode = 2;
} else {
  const report = JSON.parse(scan.stdout);
  const allDiagnostics = report.diagnostics ?? [];
  const blockingDiagnostics = allDiagnostics.filter((d) => d.severity !== 'info');
  const diagnostics = collectAislopDiagnosticCounts(blockingDiagnostics);
  const summary = report.summary ?? { errors: 0, warnings: 0 };

  const allowlist = JSON.parse(readFileSync(allowlistPath, 'utf8'));
  const allowedFingerprints = new Set((allowlist.exceptions ?? []).map((entry) => entry.fingerprint));

  console.log(
    `AI slop check: ${summary.errors} errors, ${summary.warnings} warnings `
      + `(zero-tolerance; ${allowedFingerprints.size} documented exceptions in ${allowlistPath}).`,
  );

  const unlisted = Object.keys(diagnostics)
    .filter((fingerprint) => !allowedFingerprints.has(fingerprint))
    .sort();

  if (unlisted.length > 0) {
    console.error('New AI slop diagnostics detected (not in quality/aislop-allowlist.json):');
    for (const fingerprint of unlisted.slice(0, 20)) {
      console.error(`- ${fingerprint}`);
    }
    if (unlisted.length > 20) {
      console.error(`- and ${unlisted.length - 20} more`);
    }
    process.exitCode = 1;
  }
}
