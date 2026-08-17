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

/** Return AI slop diagnostics whose count exceeds the accepted baseline. */
export function findAislopRegressions(current, baseline) {
  return Object.entries(current)
    .filter(([fingerprint, count]) => count > (baseline[fingerprint] ?? 0))
    .map(([fingerprint]) => fingerprint)
    .sort();
}
