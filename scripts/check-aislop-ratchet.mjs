import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  collectAislopDiagnosticCounts,
  findAislopRegressions,
} from './aislop-ratchet.mjs';

const repositoryRoot = process.cwd();
const baselinePath = join(repositoryRoot, 'quality/aislop-baseline.json');
const scan = spawnSync(
  process.execPath,
  [join(repositoryRoot, 'node_modules/aislop/dist/cli.js'), 'scan', '.', '--json'],
  { cwd: repositoryRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
);

if (!scan.stdout) {
  console.error('AI slop ratchet could not read scan results.');
  process.exitCode = 2;
} else {
  const report = JSON.parse(scan.stdout);
  const diagnostics = collectAislopDiagnosticCounts(report.diagnostics ?? []);
  const summary = report.summary ?? { errors: 0, warnings: 0 };

  if (process.argv.includes('--write-baseline')) {
    const baseline = {
      version: 1,
      totals: { errors: summary.errors, warnings: summary.warnings },
      diagnostics,
    };
    writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
    console.log(
      `AI slop baseline written: ${summary.errors} errors, ${summary.warnings} warnings.`,
    );
  } else {
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
    const regressions = findAislopRegressions(
      diagnostics,
      baseline.diagnostics ?? {},
    );

    console.log(
      `AI slop ratchet: ${summary.errors}/${baseline.totals.errors} errors, `
        + `${summary.warnings}/${baseline.totals.warnings} warnings.`,
    );

    if (regressions.length > 0) {
      console.error('New AI slop diagnostics detected:');
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
