import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  collectDiagnosticCounts,
  findLintRegressions,
} from './lint-ratchet.mjs';

const repositoryRoot = process.cwd();
const baselinePath = join(repositoryRoot, 'quality/lint-baseline.json');
const eslint = spawnSync(
  process.execPath,
  [join(repositoryRoot, 'node_modules/eslint/bin/eslint.js'), '.', '--format', 'json'],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
);

if (!eslint.stdout) {
  console.error('Lint ratchet could not read ESLint results.');
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

  if (process.argv.includes('--write-baseline')) {
    const baseline = { version: 1, totals, diagnostics };
    writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
    console.log(
      `Lint baseline written: ${totals.errors} errors, ${totals.warnings} warnings.`,
    );
  } else {
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
    const regressions = findLintRegressions(diagnostics, baseline.diagnostics ?? {});

    console.log(
      `Lint ratchet: ${totals.errors}/${baseline.totals.errors} errors, `
        + `${totals.warnings}/${baseline.totals.warnings} warnings.`,
    );

    if (regressions.length > 0) {
      console.error('New lint diagnostics detected:');
      for (const fingerprint of regressions.slice(0, 20)) {
        console.error(`- ${fingerprint}`);
      }
      if (regressions.length > 20) {
        console.error(`- and ${regressions.length - 20} more`);
      }
      process.exitCode = 1;
    }
  }
}
