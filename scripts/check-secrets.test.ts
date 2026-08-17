import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('check-secrets command', () => {
  it('fails safely when a file contains a secret-like credential', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orbita-secret-scan-'));
    temporaryDirectories.push(directory);
    const fixturePath = join(directory, 'unsafe.env');
    const syntheticSecret = ['sk', 'live', 'syntheticvalue1234567890'].join('_');
    writeFileSync(fixturePath, `PAYMENT_KEY=${syntheticSecret}\n`, 'utf8');

    const result = spawnSync(
      process.execPath,
      [resolve('scripts/check-secrets.mjs'), fixturePath],
      { encoding: 'utf8' },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('unsafe.env');
    expect(result.stdout).not.toContain(syntheticSecret);
  });

  it('passes for a sanitized environment example', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orbita-secret-scan-'));
    temporaryDirectories.push(directory);
    const fixturePath = join(directory, '.env.example');
    writeFileSync(fixturePath, 'PAYMENT_KEY=replace-me\n', 'utf8');

    const result = spawnSync(
      process.execPath,
      [resolve('scripts/check-secrets.mjs'), fixturePath],
      { encoding: 'utf8' },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Secret scan passed');
  });

  it('detects provider credentials without echoing their values', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orbita-secret-scan-'));
    temporaryDirectories.push(directory);
    const fixturePath = join(directory, 'provider.env');
    const syntheticSecret = ['synthetic', 'chatwoot', 'credential', '1234567890'].join('-');
    writeFileSync(
      fixturePath,
      `${['CHATWOOT', 'API', 'TOKEN'].join('_')}=${syntheticSecret}\n`,
      'utf8',
    );

    const result = spawnSync(
      process.execPath,
      [resolve('scripts/check-secrets.mjs'), fixturePath],
      { encoding: 'utf8' },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('provider.env');
    expect(result.stdout).not.toContain(syntheticSecret);
  });

  it('detects a provider credential hardcoded in application code', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orbita-secret-scan-'));
    temporaryDirectories.push(directory);
    const fixturePath = join(directory, 'unsafe.ts');
    const variableName = ['CHATWOOT', 'WEBHOOK', 'SECRET'].join('_');
    const syntheticSecret = ['synthetic', 'webhook', 'credential', '1234567890'].join('-');
    writeFileSync(
      fixturePath,
      `const ${variableName} = '${syntheticSecret}';\n`,
      'utf8',
    );

    const result = spawnSync(
      process.execPath,
      [resolve('scripts/check-secrets.mjs'), fixturePath],
      { encoding: 'utf8' },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('unsafe.ts');
    expect(result.stdout).not.toContain(syntheticSecret);
  });

  it('detects a credential added and removed inside a commit range', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orbita-secret-history-'));
    temporaryDirectories.push(directory);
    const scannerPath = resolve('scripts/check-secrets.mjs');
    const secretPath = join(directory, 'historical.env');
    const syntheticSecret = ['synthetic', 'bling', 'credential', '1234567890'].join('-');
    const runGit = (...args: string[]) =>
      spawnSync('git', args, { cwd: directory, encoding: 'utf8' });

    expect(runGit('init').status).toBe(0);
    expect(runGit('config', 'user.email', 'tests@orbita.local').status).toBe(0);
    expect(runGit('config', 'user.name', 'ORBITA Tests').status).toBe(0);
    writeFileSync(join(directory, 'README.md'), 'safe\n', 'utf8');
    expect(runGit('add', 'README.md').status).toBe(0);
    expect(runGit('commit', '-m', 'safe baseline').status).toBe(0);
    const baseCommit = runGit('rev-parse', 'HEAD').stdout.trim();

    writeFileSync(
      secretPath,
      `${['BLING', 'CLIENT', 'SECRET'].join('_')}=${syntheticSecret}\n`,
      'utf8',
    );
    expect(runGit('add', 'historical.env').status).toBe(0);
    expect(runGit('commit', '-m', 'add credential').status).toBe(0);
    rmSync(secretPath);
    expect(runGit('add', '-u').status).toBe(0);
    expect(runGit('commit', '-m', 'remove credential').status).toBe(0);

    const result = spawnSync(
      process.execPath,
      [scannerPath, '--git-range', `${baseCommit}..HEAD`],
      { cwd: directory, encoding: 'utf8' },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('commit history');
    expect(result.stdout).not.toContain(syntheticSecret);
  });
});
