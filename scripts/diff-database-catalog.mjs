#!/usr/bin/env node
/**
 * Diagnóstico de divergência de catálogo entre dois bancos.
 *
 * `database-catalog.mjs` produz um único SHA-256 do snapshot inteiro. Isso
 * responde "igual ou diferente" e nada mais — foi exatamente o beco em que a
 * comparação laboratório × staging parou: as 7 contagens batiam e o
 * fingerprint divergia, sem nenhuma pista de onde.
 *
 * Este script captura o mesmo snapshot de dois bancos e diz **qual dimensão**
 * diverge, **quantas linhas** e **quais campos** — separando o que é diferença
 * real de esquema do que é apenas metadado do ambiente (dono do objeto, ACL,
 * roles), que difere por construção entre um laboratório descartável e um
 * projeto Supabase hospedado.
 *
 * Uso:
 *   node scripts/diff-database-catalog.mjs --a "<conn A>" --b "<conn B>"
 *   node scripts/diff-database-catalog.mjs --a-local --b "$SUPABASE_STAGING_DB_URL"
 *
 * Nenhuma escrita é feita: só `select` em catálogos do PostgreSQL.
 */
import { createHash } from 'node:crypto';
import pg from 'pg';

import { CATALOG_QUERIES } from './database-catalog.mjs';
import { createLocalDatabaseClient } from './local-database-client.mjs';

const { Client } = pg;

/**
 * Campos cujo valor depende do ambiente, não do esquema declarado nas
 * migrations. Um laboratório local e um projeto hospedado divergem neles sem
 * que exista qualquer diferença estrutural.
 */
const ENVIRONMENT_DEPENDENT_FIELDS = Object.freeze({
  functions: ['owner', 'acl'],
  policies: ['roles'],
});

/** Chave estável de identidade de uma linha dentro de cada dimensão. */
const ROW_IDENTITY = Object.freeze({
  relations: (row) => `${row.kind}:${row.name}`,
  columns: (row) => `${row.table_name}.${row.column_name}`,
  policies: (row) => `${row.tablename}.${row.policyname}`,
  functions: (row) => `${row.name}(${row.arguments})`,
  constraints: (row) => `${row.table_name}.${row.name}`,
  indexes: (row) => `${row.tablename}.${row.indexname}`,
  triggers: (row) => `${row.table_name}.${row.name}`,
});

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

/** Remove de uma linha os campos que dependem do ambiente. */
function withoutEnvironmentFields(dimension, row) {
  const drop = ENVIRONMENT_DEPENDENT_FIELDS[dimension] ?? [];
  if (drop.length === 0) return row;
  return Object.fromEntries(Object.entries(row).filter(([key]) => !drop.includes(key)));
}

function clientFor(target) {
  // O laboratório reusa o cliente já existente em vez de repetir credenciais
  // locais aqui: uma única definição do alvo descartável, e nenhum literal de
  // senha neste arquivo.
  if (target === 'local') return createLocalDatabaseClient('orbita-catalog-diff');
  return new Client({ connectionString: target, application_name: 'orbita-catalog-diff' });
}

/** Captura o snapshot de catálogo de um banco. */
export async function captureCatalogFrom(target) {
  const client = clientFor(target);
  const snapshot = {};
  try {
    await client.connect();
    for (const [name, query] of Object.entries(CATALOG_QUERIES)) {
      snapshot[name] = (await client.query(query)).rows;
    }
  } finally {
    await client.end().catch(() => {});
  }
  return snapshot;
}

/**
 * Compara dois snapshots e devolve, por dimensão, o que difere.
 *
 * @returns {{ dimension: string, counts: [number, number], sameWithEnvironment: boolean,
 *   sameWithoutEnvironment: boolean, onlyInA: string[], onlyInB: string[],
 *   changed: Array<{ key: string, fields: string[] }> }[]}
 */
export function diffCatalogs(a, b) {
  return Object.keys(CATALOG_QUERIES).map((dimension) => {
    const rowsA = a[dimension] ?? [];
    const rowsB = b[dimension] ?? [];
    const identity = ROW_IDENTITY[dimension] ?? ((row) => JSON.stringify(stableValue(row)));

    const mapA = new Map(rowsA.map((row) => [identity(row), row]));
    const mapB = new Map(rowsB.map((row) => [identity(row), row]));

    const onlyInA = [...mapA.keys()].filter((k) => !mapB.has(k));
    const onlyInB = [...mapB.keys()].filter((k) => !mapA.has(k));

    const changed = [];
    for (const [key, rowA] of mapA) {
      const rowB = mapB.get(key);
      if (!rowB) continue;
      const fields = Object.keys(rowA).filter((f) => digest(rowA[f]) !== digest(rowB[f]));
      if (fields.length > 0) changed.push({ key, fields });
    }

    const strippedA = rowsA.map((row) => withoutEnvironmentFields(dimension, row));
    const strippedB = rowsB.map((row) => withoutEnvironmentFields(dimension, row));

    return {
      dimension,
      counts: [rowsA.length, rowsB.length],
      sameWithEnvironment: digest(rowsA) === digest(rowsB),
      sameWithoutEnvironment: digest(strippedA) === digest(strippedB),
      onlyInA,
      onlyInB,
      changed,
    };
  });
}

/** Resume o diff em linhas legíveis, sem despejar definição de função inteira. */
export function formatDiff(results) {
  const lines = [];
  for (const r of results) {
    const [countA, countB] = r.counts;
    const veredicto = r.sameWithEnvironment
      ? 'idêntico'
      : r.sameWithoutEnvironment
        ? 'DIFERE APENAS EM METADADO DE AMBIENTE (dono/ACL/roles)'
        : 'DIVERGÊNCIA ESTRUTURAL';
    lines.push(`${r.dimension}: A=${countA} B=${countB} — ${veredicto}`);

    if (r.onlyInA.length) lines.push(`  só em A (${r.onlyInA.length}): ${r.onlyInA.slice(0, 10).join(', ')}`);
    if (r.onlyInB.length) lines.push(`  só em B (${r.onlyInB.length}): ${r.onlyInB.slice(0, 10).join(', ')}`);

    if (r.changed.length) {
      const porCampo = new Map();
      for (const c of r.changed) {
        for (const f of c.fields) porCampo.set(f, (porCampo.get(f) ?? 0) + 1);
      }
      const resumo = [...porCampo.entries()].sort((x, y) => y[1] - x[1]).map(([f, n]) => `${f}×${n}`).join(', ');
      lines.push(`  linhas com campo diferente: ${r.changed.length} — ${resumo}`);
      for (const c of r.changed.slice(0, 5)) {
        lines.push(`    ex.: ${c.key} → ${c.fields.join(', ')}`);
      }
    }
  }
  return lines.join('\n');
}

function readArgs(argv) {
  const args = { a: null, b: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--a-local') args.a = 'local';
    else if (argv[i] === '--b-local') args.b = 'local';
    else if (argv[i] === '--a') { i += 1; args.a = argv[i]; }
    else if (argv[i] === '--b') { i += 1; args.b = argv[i]; }
  }
  return args;
}

if (process.argv[1] && process.argv[1].endsWith('diff-database-catalog.mjs')) {
  const { a, b } = readArgs(process.argv.slice(2));
  if (!a || !b) {
    console.error('Uso: node scripts/diff-database-catalog.mjs --a-local --b "<connection string>"');
    process.exit(2);
  }

  const [snapshotA, snapshotB] = await Promise.all([captureCatalogFrom(a), captureCatalogFrom(b)]);
  const results = diffCatalogs(snapshotA, snapshotB);

  console.log(`fingerprint A: ${digest(snapshotA)}`);
  console.log(`fingerprint B: ${digest(snapshotB)}`);
  console.log('');
  console.log(formatDiff(results));

  const estrutural = results.filter((r) => !r.sameWithoutEnvironment);
  console.log('');
  if (estrutural.length === 0) {
    console.log('VEREDICTO: nenhuma divergência estrutural. O fingerprint difere apenas por metadado de ambiente.');
  } else {
    console.log(`VEREDICTO: ${estrutural.length} dimensão(ões) com divergência estrutural: ${estrutural.map((r) => r.dimension).join(', ')}`);
  }
  process.exit(estrutural.length === 0 ? 0 : 1);
}
