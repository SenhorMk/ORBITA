import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * MSG-020C: o restore-check com um Postgres que nunca fica pronto. Exige Docker;
 * roda em `npm run test:worker`. A imagem do Redis, já usada pelo Chatwoot, sobe
 * mas não tem pg_isready: a espera nunca termina sozinha.
 */
const REDIS = 'redis:7-alpine@sha256:8da19c7399dca900c6822a1cf30f9d2285585e2c4b457ff4095b0f4500054d3f';

function bash() {
  if (process.platform !== 'win32') return 'bash';
  const exec = spawnSync('git', ['--exec-path'], { encoding: 'utf8' }).stdout.trim();
  const candidato = resolve(exec, '../../../bin/bash.exe');
  if (!existsSync(candidato)) throw new Error('bash do Git for Windows não encontrado');
  return candidato;
}

const sobrando = () => spawnSync('docker', ['ps', '-aq', '--filter', 'name=chatwoot-restore-check-'], { encoding: 'utf8' }).stdout.trim();

describe('restore-check com Postgres que não inicializa', () => {
  it('desiste no prazo, sai com erro e remove o container descartável', async () => {
    expect(sobrando()).toBe('');
    const pasta = mkdtempSync(join(tmpdir(), 'orbita-restore-'));
    const env = join(pasta, 'chatwoot.env');
    writeFileSync(env, `BACKUP_DIR=${pasta.split(sep).join('/')}\n`);
    const dump = join(pasta, 'chatwoot-sintetico.dump');
    writeFileSync(dump, 'nao e um dump');

    const inicio = Date.now();
    const filho = spawn(bash(), ['infra/chatwoot-vm/restore-check.sh', dump.split(sep).join('/')], {
      env: { ...process.env, CHATWOOT_ENV_FILE: env.split(sep).join('/'), RESTORE_CHECK_IMAGE: REDIS, RESTORE_CHECK_TIMEOUT_SECONDS: '5', MSYS_NO_PATHCONV: '1' },
    });
    let erro = '';
    filho.stderr.on('data', (c) => { erro += c; });
    const codigo = await new Promise<number | null>((ok) => { filho.on('close', ok); });

    expect(codigo).not.toBe(0);
    expect(erro).toMatch(/não ficou pronto/u);
    expect(Date.now() - inicio).toBeLessThan(45_000);
    expect(sobrando()).toBe('');
  }, 60_000);
});
