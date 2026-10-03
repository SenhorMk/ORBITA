/** Build stable per-file fingerprints for AI slop diagnostics. */
export function collectAislopDiagnosticCounts(diagnostics) {
  const counts = {};

  for (const diagnostic of diagnostics) {
    const fingerprint = [
      diagnostic.filePath.replaceAll('\\', '/'),
      diagnostic.engine,
      diagnostic.rule,
      diagnostic.severity,
      diagnostic.message.replace(/\s+/gu, ' ').trim(),
    ].join('|');
    counts[fingerprint] = (counts[fingerprint] ?? 0) + 1;
  }

  return counts;
}

/**
 * The gate decision: blocking fingerprints that no documented exception covers.
 * `severity: info` never blocks. Matching is by EXACT fingerprint string — no
 * wildcard, prefix or pattern — so an exception covers one diagnostic only,
 * and any change to its file, engine, rule, severity or message fails again.
 */
export function findUnlistedDiagnostics(diagnostics, allowlist) {
  const blocking = diagnostics.filter((diagnostic) => diagnostic.severity !== 'info');
  const allowed = new Set((allowlist.exceptions ?? []).map((entry) => entry.fingerprint));
  return Object.keys(collectAislopDiagnosticCounts(blocking))
    .filter((fingerprint) => !allowed.has(fingerprint))
    .sort();
}

/** Return AI slop diagnostics whose count exceeds the accepted baseline. */
export function findAislopRegressions(current, baseline) {
  return Object.entries(current)
    .filter(([fingerprint, count]) => count > (baseline[fingerprint] ?? 0))
    .map(([fingerprint]) => fingerprint)
    .sort();
}
