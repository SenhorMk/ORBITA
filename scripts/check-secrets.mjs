import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';

const MAX_SCANNED_BYTES = 2_000_000;

const detectors = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/u,
  /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/u,
  /sb_secret_[A-Za-z0-9_-]{16,}/u,
  /gh[pousr]_[A-Za-z0-9]{20,}/u,
  /AIza[0-9A-Za-z_-]{25,}/u,
  /nvapi-[A-Za-z0-9_-]{20,}/u,
  /^[ \t]*SUPABASE_SERVICE_ROLE_KEY[ \t]*=[ \t]*(?!$|replace-me$|your[-_])\S+/imu,
];

const credentialVariables = new Set([
  'BLING_API_KEY',
  'BLING_CLIENT_SECRET',
  'CHATWOOT_API_TOKEN',
  'CHATWOOT_WEBHOOK_SECRET',
  'ENCRYPTION_KEY',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'SUPABASE_SERVICE_ROLE_KEY',
]);

function isPlaceholder(value) {
  const normalized = value
    .trim()
    .replace(/[;,]\s*$/u, '')
    .trim()
    .replace(/^['"`]|['"`]$/gu, '');
  return (
    normalized.length === 0 ||
    /^(?:change-?me|ci[-_]test.*|example|placeholder|replace-?me|your[-_].*|<.*>)$/iu.test(normalized) ||
    /^(?:[A-Za-z_$][\w$]*\.|\$\{\{\s*(?:secrets|vars)\.)/u.test(normalized)
  );
}

function containsAssignedCredential(text) {
  return text.split(/\r?\n/u).some((line) => {
    const environmentAssignment = line.match(
      /^[ \t]*([A-Z][A-Z0-9_]*)[ \t]*=[ \t]*(.*)$/u,
    );
    if (environmentAssignment) {
      return credentialVariables.has(environmentAssignment[1])
        && !isPlaceholder(environmentAssignment[2]);
    }

    const codeAssignment = line.match(
      /^[ \t]*(?:const|let|var)[ \t]+([A-Z][A-Z0-9_]*)[ \t]*=[ \t]*(.*)$/u,
    );
    if (codeAssignment) {
      const value = codeAssignment[2].trim().replace(/;\s*$/u, '');
      const isLiteral = /^(['"`])[\s\S]*\1$/u.test(value);
      return credentialVariables.has(codeAssignment[1])
        && isLiteral
        && !isPlaceholder(value);
    }

    const structuredAssignment = line.match(
      /^[ \t]*['"]?([A-Z][A-Z0-9_]*)['"]?[ \t]*:[ \t]*(.*?)[,]?[ \t]*$/u,
    );
    return Boolean(
      structuredAssignment
      && credentialVariables.has(structuredAssignment[1])
      && !isPlaceholder(structuredAssignment[2]),
    );
  });
}

function containsSecretText(text) {
  return containsAssignedCredential(text) || detectors.some((detector) => detector.test(text));
}

function repositoryFiles() {
  const output = execFileSync(
    'git',
    ['ls-files', '-co', '--exclude-standard', '-z'],
    { encoding: 'utf8' },
  );

  return output.split('\0').filter(Boolean);
}

function canScan(filePath) {
  try {
    return statSync(filePath).isFile() && statSync(filePath).size <= MAX_SCANNED_BYTES;
  } catch {
    return false;
  }
}

function containsSecret(filePath) {
  if (!canScan(filePath)) {
    return false;
  }

  const contents = readFileSync(filePath);
  if (contents.includes(0)) {
    return false;
  }

  return containsSecretText(contents.toString('utf8'));
}

function parseArguments(arguments_) {
  const files = [];
  let gitRange = null;

  for (let index = 0; index < arguments_.length; index += 1) {
    if (arguments_[index] === '--git-range') {
      gitRange = arguments_[index + 1] ?? null;
      index += 1;
    } else {
      files.push(arguments_[index]);
    }
  }

  return { files, gitRange };
}

function historyContainsSecret(gitRange) {
  if (!gitRange) return false;

  const commits = execFileSync('git', ['rev-list', '--reverse', gitRange], {
    encoding: 'utf8',
  })
    .split(/\r?\n/u)
    .filter(Boolean);

  return commits.some((commit) => {
    const patch = execFileSync(
      'git',
      ['show', '--format=', '--unified=0', '--no-ext-diff', commit],
      { encoding: 'utf8', maxBuffer: 20_000_000 },
    );
    const additions = patch
      .split(/\r?\n/u)
      .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
      .map((line) => line.slice(1))
      .join('\n');

    return containsSecretText(additions);
  });
}

const { files: requestedFiles, gitRange } = parseArguments(process.argv.slice(2));
const files = requestedFiles.length > 0 ? requestedFiles : repositoryFiles();
const findings = files
  .map((filePath) => resolve(filePath))
  .filter(containsSecret);
const historyFinding = historyContainsSecret(gitRange);

if (findings.length > 0 || historyFinding) {
  console.log('Secret scan failed. Potential credentials found in:');
  for (const filePath of findings) {
    console.log(`- ${basename(filePath)}`);
  }
  if (historyFinding) {
    console.log('- commit history');
  }
  console.log('Values were intentionally redacted. Rotate confirmed credentials before release.');
  process.exitCode = 1;
} else {
  const rangeSummary = gitRange ? ' and commit range checked' : '';
  console.log(`Secret scan passed (${files.length} files checked${rangeSummary}).`);
}
