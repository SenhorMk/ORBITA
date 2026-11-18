import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { captureDatabaseCatalog, catalogFingerprint } from '../../scripts/database-catalog.mjs';

const ref = JSON.parse(readFileSync(new URL('../../database/catalog-reference.json',import.meta.url),'utf8'));
async function capture(options) {
  const res=await captureDatabaseCatalog({client:new Client({ host:'127.0.0.1',port:55482,
    user:'postgres',database:'orbita_d084_catalog_base',ssl:false,options })});
  assert.equal(res._tag,'ok');
  return res.value;
}
const normal=await capture(undefined);
const qualified=await capture('-c search_path=pg_catalog');
assert.deepEqual(normal.counts,ref.counts);
assert.deepEqual(qualified.counts,normal.counts);
const changedDefinitions=Object.entries(normal.snapshot).filter(([name, rows]) =>
  catalogFingerprint(rows)!==catalogFingerprint(qualified.snapshot[name])).map(([name])=>name);
console.log(JSON.stringify({ official:ref.fingerprint, native:normal.fingerprint, qualified:qualified.fingerprint,
  changedDefinitions, rootCauseEstablished:false },null,2));
