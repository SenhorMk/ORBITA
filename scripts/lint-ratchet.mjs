import { relative } from 'node:path';

function normalizePath(filePath, repositoryRoot) {
  return relative(repositoryRoot, filePath).replaceAll('\\', '/');
}

/** Remove platform-specific paths and code frames from an ESLint message. */
export function normalizeDiagnosticMessage(message, repositoryRoot) {
  const normalizedMessage = message.replaceAll('\\', '/');
  const normalizedRoot = repositoryRoot.replaceAll('\\', '/').replace(/\/$/u, '');
  const rootIndex = normalizedMessage.toLowerCase().indexOf(normalizedRoot.toLowerCase());
  const portableMessage = rootIndex >= 0
    ? normalizedMessage.slice(0, rootIndex)
    : normalizedMessage;

  return portableMessage.replace(/\s+/gu, ' ').trim();
}

/** Build stable per-file fingerprints for every ESLint diagnostic. */
export function collectDiagnosticCounts(results, repositoryRoot) {
  const diagnostics = {};

  for (const result of results) {
    const filePath = normalizePath(result.filePath, repositoryRoot);
    for (const message of result.messages) {
      const normalizedMessage = normalizeDiagnosticMessage(
        message.message,
        repositoryRoot,
      );
      const fingerprint = [
        filePath,
        message.severity,
        message.ruleId ?? 'unknown-rule',
        normalizedMessage,
      ].join('|');
      diagnostics[fingerprint] = (diagnostics[fingerprint] ?? 0) + 1;
    }
  }

  return diagnostics;
}

/** Return diagnostics whose per-file count exceeds the accepted baseline. */
export function findLintRegressions(current, baseline) {
  return Object.entries(current)
    .filter(([fingerprint, count]) => count > (baseline[fingerprint] ?? 0))
    .map(([fingerprint]) => fingerprint)
    .sort();
}
