import fs from 'node:fs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { applyCanonicalMigrations, alinharStubDeAuthComProducao } from './database-lab.mjs';
import { createLocalDatabaseClient } from './local-database-client.mjs';
import { captureDatabaseCatalog, writeCatalogReference } from './database-catalog.mjs';

// Dedicated throwaway container only. No connection string or remote option exists.
const container = JSON.parse(execFileSync('docker', ['inspect', 'orbita-assistente-produtos-lab'], { encoding: 'utf8' }))[0];
assert.equal(container.Config.Labels['orbita.task'], 'assistente-editar-produtos');
assert.equal(container.State.Running, true);
assert.equal(container.NetworkSettings.Ports['5432/tcp'].some(binding => binding.HostIp === '127.0.0.1' && binding.HostPort === '55404'), true);
const local = role => createLocalDatabaseClient('assistente-edicao-local', console, 55404, role);
const precisa = result => { assert.equal(result._tag, 'ok', JSON.stringify(result)); return result.value; };
if (!process.argv.includes('--somente-testes')) {
  precisa(await alinharStubDeAuthComProducao({ createClient: () => local('supabase_auth_admin') }));
  precisa(await applyCanonicalMigrations({ client: local() }));
}
const client = local();
await client.connect();
try {
  await client.query('create extension if not exists pgtap with schema extensions; set search_path=public,extensions');
  const respostas = await client.query(fs.readFileSync('supabase/tests/final/assistente_edicao_produtos.test.sql', 'utf8'));
  const linhas = respostas.flatMap(resposta => resposta.rows.flatMap(row => Object.values(row)))
    .filter(valor => typeof valor === 'string' && /^(?:ok|not ok|1\.\.|#)/u.test(valor));
  console.log(linhas.join('\n'));
  assert.equal(linhas.filter(l => l.startsWith('ok ')).length, 26);
  assert.equal(linhas.some(l => l.startsWith('not ok') || l.includes('Looks like')), false);
} finally {
  await client.end();
}
if (process.argv.includes('--atualizar-catalogo')) {
  precisa(await writeCatalogReference({ capture: () => captureDatabaseCatalog({ client: local() }) }));
}
