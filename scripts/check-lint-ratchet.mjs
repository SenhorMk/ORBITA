import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { collectDiagnosticCounts } from './lint-ratchet.mjs';

// Zero-tolerance ESLint gate (ticket 20): there is no baseline/ratchet file
// and no ceiling. Any ESLint error or warning fails the build. If a warning
// is ever intentionally accepted, it must be fixed for real, disabled with a
// narrowly-scoped and justified inline directive reviewed in the PR, or the
// underlying ESLint rule itself must be reconsidered — never re-introduced
// as an anonymous baseline entry.
const repositoryRoot = process.cwd();
const eslint = spawnSync(
  process.execPath,
  [join(repositoryRoot, 'node_modules/eslint/bin/eslint.js'), '.', '--format', 'json'],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
);

if (!eslint.stdout) {
  console.error('Lint check could not read ESLint results.');
  console.error(eslint.stderr || '(no stderr captured)');
  process.exitCode = 2;
} else {
  const results = JSON.parse(eslint.stdout);
  const diagnostics = collectDiagnosticCounts(results, repositoryRoot);
  const totals = results.reduce(
    (current, result) => ({
      errors: current.errors + result.errorCount,
      warnings: current.warnings + result.warningCount,
    }),
    { errors: 0, warnings: 0 },
  );

  console.log(`Lint check: ${totals.errors} errors, ${totals.warnings} warnings (zero-tolerance).`);

  const fingerprints = Object.keys(diagnostics).sort();
  if (fingerprints.length > 0) {
    console.error('ESLint diagnostics found (zero-tolerance — none are permitted):');
    for (const fingerprint of fingerprints.slice(0, 30)) {
      console.error(`- ${fingerprint}`);
    }
    if (fingerprints.length > 30) {
      console.error(`- and ${fingerprints.length - 30} more`);
    }
    process.exitCode = 1;
  }
}
