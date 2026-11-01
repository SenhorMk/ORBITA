import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';

import { createLocalDatabaseClient, DEFAULT_LOCAL_DATABASE_PORT } from './local-database-client.mjs';
import { err, ok } from './script-result.mjs';

/**
 * MSG-006. Prova integrada contra o laboratório descartável, com fixtures
 * sintéticas: handler real do webhook → PostgREST real → Postgres real → worker
 * real (em processo e como processo separado, morto de verdade) → leitura do
 * operador. NÃO é um E2E real: o Chatwoot local depende do MSG-001, e a sessão do
 * operador é um contexto injetado, porque `supabase db start` não sobe o GoTrue.
 *
 * O PostgREST roda só durante esta etapa, preso a 127.0.0.1, com uma chave
 * aleatória gerada aqui. Só fala com o Postgres do laboratório.
 */

// Fixado por digest: a versão não muda sozinha entre execuções.
const IMAGEM_POSTGREST = 'postgrest/postgrest@sha256:85258123312dc496ad4c2ed832154a65e9746f84df0d6d09b44229ff9230c08e';
const CONTAINER = 'orbita-database-lab-postgrest';
const REDE = 'supabase_network_orbita-database-lab';
const BANCO = 'supabase_db_orbita-database-lab';
const PORTA_REST = 54398;
const PORTA_PROXY = 54399;

function docker(args) {
  return spawnSync('docker', args, { encoding: 'utf8', shell: false });
}

/**
 * O `auth.role()` do esqueleto do laboratório só lê a GUC antiga, e o PostgREST atual
 * grava `request.jwt.claims`. Produção lê as duas. Alinhamento só do laboratório, como
 * `alinharStubDeAuthComProducao`; não é migration.
 */
async function alinharPapelDoJwt() {
  const client = createLocalDatabaseClient('orbita-integracao-auth', console, DEFAULT_LOCAL_DATABASE_PORT, 'supabase_auth_admin');
  await client.connect();
  try {
    await client.query(`
      create or replace function auth.role() returns text language sql stable as $$
        select coalesce(
          nullif(current_setting('request.jwt.claim.role', true), ''),
          nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')::text;
      $$`);
  } finally {
    await client.end();
  }
}

async function esperarRest() {
  for (let i = 0; i < 150; i += 1) {
    try {
      const resposta = await fetch(`http://127.0.0.1:${PORTA_REST}/`, { signal: AbortSignal.timeout(1000) });
      if (resposta.status < 500) return true;
    } catch {
      // Ainda subindo.
    }
    await new Promise((resolve) => { setTimeout(resolve, 200); });
  }
  return false;
}

/** @returns {Promise<object>} Resultado tagueado da prova integrada. */
export async function runIntegracaoConsumidorInbox() {
  const segredo = crypto.randomBytes(32).toString('hex');
  docker(['rm', '-f', CONTAINER]);
  try {
    await alinharPapelDoJwt();
    const subiu = docker([
      'run', '-d', '--name', CONTAINER, '--network', REDE, '-p', `127.0.0.1:${PORTA_REST}:3000`,
      '-e', `PGRST_DB_URI=postgres://authenticator:postgres@${BANCO}:5432/postgres`,
      '-e', 'PGRST_DB_SCHEMAS=public',
      '-e', 'PGRST_DB_ANON_ROLE=anon',
      '-e', `PGRST_JWT_SECRET=${segredo}`,
      IMAGEM_POSTGREST,
    ]);
    if (subiu.status !== 0) {
      return err('IntegracaoPostgrestNaoSubiu', 'O PostgREST do laboratório não subiu', { saida: String(subiu.stderr).slice(0, 300) });
    }
    if (!(await esperarRest())) {
      return err('IntegracaoPostgrestSemResposta', 'O PostgREST do laboratório não respondeu', { logs: String(docker(['logs', '--tail', '20', CONTAINER]).stderr).slice(-600) });
    }

    const execucao = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.integracao.config.ts'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      shell: false,
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env,
        NO_COLOR: '1',
        ORBITA_LAB_REST_PORT: String(PORTA_REST),
        ORBITA_LAB_PROXY_PORT: String(PORTA_PROXY),
        ORBITA_LAB_JWT_SECRET: segredo,
      },
    });
    const saida = `${execucao.stdout ?? ''}\n${execucao.stderr ?? ''}`;
    if (execucao.status !== 0) {
      const relevante = saida.split('\n').filter((l) => !l.startsWith('{') && !/^\[[A-Z]+\]/.test(l)).join('\n').slice(-4000);
      return err('IntegracaoConsumidorFalhou', `Prova integrada falhou:\n${relevante}`, { exit: execucao.status });
    }
    const testes = /Tests\s+(\d+) passed/.exec(saida)?.[1] ?? '?';
    return ok(Object.freeze({
      relato: `prova integrada do MSG-006 (webhook real, PostgREST real, worker real, processo morto e reiniciado): ${testes} testes; NÃO é E2E com Chatwoot real`,
    }));
  } catch (cause) {
    return err('IntegracaoConsumidorErro', 'Falha inesperada na prova integrada', {}, cause);
  } finally {
    docker(['rm', '-f', CONTAINER]);
  }
}
