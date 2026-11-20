import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Client } from 'pg';
import { captureDatabaseCatalog, catalogFingerprint } from '../../scripts/database-catalog.mjs';
import { readCanonicalLedger, validateCanonicalLedger } from '../../scripts/database-ledger.mjs';
import { aplicarPendentes, estadoDasMigracoes, planejarAplicacao } from '../../scripts/migracoes-remotas.mjs';

const local = {host:'127.0.0.1',port:55482,user:'postgres',database:'orbita_d085',ssl:false};
const frozen = [
  'a28493aa87891686085d467f5f58a71391cb60d6997ce0e150fa95a619fa5708',
  '1c97c8cab3fbb39bdd49899f3cee8215181f67375de9b327d6172ebfe7a0cbcb',
  'b2189c4a836ecee297d5f0a1dc4cb53c5b8fe64e314b00f4f85211e24142f7ec',
  'e4394fb2b0b240630886763065dabd9c86acb61a8c34e2b4751aa476727171a6',
];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function capture() {
  const r = await captureDatabaseCatalog({client:new Client(local)});
  assert.equal(r._tag,'ok');
  return r.value;
}
function withoutRegistry(snapshot) {
  // This public table is created by the migration runner, outside the app schema.
  return Object.fromEntries(Object.entries(snapshot).map(([kind,rows]) => [
    kind, rows.filter(row => ![row.name,row.table_name,row.tablename].includes('migracoes_aplicadas')),
  ]));
}
test('validates frozen bytes, rollback of 97/98, replay through the real migration ledger', {timeout:35000}, async () => {
  assert.equal(process.env.ORBITA_D085_DISPOSABLE,'yes');
  const valid = validateCanonicalLedger();
  assert.equal(valid._tag,'ok');
  const ledgerResult = readCanonicalLedger();
  assert.equal(ledgerResult._tag,'ok');
  const items = ledgerResult.value.migrations;
  assert.deepEqual(items.slice(95,99).map(m=>m.sha256),frozen);
  assert.deepEqual(items.slice(99).map(m=>[m.order,m.path]),[
    [100,'../database/97_bootstrap_ai_first.sql'],[101,'../database/98_ai_first_worker.sql'],
  ]);
  assert.deepEqual(items.slice(95,99).map(m=>sha(readFileSync(new URL(m.path,new URL('../../supabase/',import.meta.url))))), frozen);
  const p = new Client(local);
  await p.connect();
  try {
    assert.equal((await p.query("select to_regclass('public.chatwoot_ai_runtime') is null as fresh")).rows[0].fresh,true);
    const base=await capture();
    const ref=JSON.parse(readFileSync(new URL('../../database/catalog-reference.json',import.meta.url),'utf8'));
    assert.deepEqual(base.counts,ref.counts);
    assert.notEqual(base.fingerprint,ref.fingerprint);
    console.log(JSON.stringify({baseNative:base.fingerprint, officialReference:ref.fingerprint, counts:base.counts}));

    await p.query(`create table public.migracoes_aplicadas (
      ordem integer not null, arquivo text primary key, sha256 text not null,
      aplicada_em timestamptz not null default now(), constraint reprova_97 check (ordem<>100))`);
    for (const m of items.slice(0,99)) {
      await p.query('insert into public.migracoes_aplicadas(ordem,arquivo,sha256) values($1,$2,$3)',[m.order,m.path,m.sha256]);
    }
    const check=()=>estadoDasMigracoes({client:p,ledgerResult});
    const pre=await check();
    assert.equal(pre._tag,'ok');
    const plano=planejarAplicacao({estado:pre.value,limite:{ordem:101},ledger:items});
    assert.equal(plano._tag,'ok');
    assert.deepEqual(pre.value.pendentes.map(m=>m.order),[100,101]);

    const failed97=await aplicarPendentes({client:p,pendentes:items.slice(99,100)});
    assert.equal(failed97.error?._tag,'MigracaoRemotaFalhou');
    assert.equal(failed97.error.sqlstate,'23514');
    assert.deepEqual((await check()).value.pendentes.map(m=>m.order),[100,101]);
    assert.equal(catalogFingerprint(withoutRegistry((await capture()).snapshot)),base.fingerprint);
    console.log('Failed registry insert rolled back 97 and restored the exact prior app catalog.');
    await p.query('alter table public.migracoes_aplicadas drop constraint reprova_97, add constraint reprova_98 check (ordem<>101)');

    // The original 98 runs to completion, then the real registry insert fails.
    const failed=await aplicarPendentes({client:p,pendentes:items.slice(99)});
    assert.equal(failed.error?._tag,'MigracaoRemotaFalhou');
    assert.equal(failed.error.sqlstate,'23514');
    assert.match(failed.error.message,/98_ai_first_worker/);
    const state=(await check()).value;
    assert.deepEqual(state.pendentes.map(m=>m.order),[101]);
    const rollback=(await p.query(`select
      to_regclass('public.chatwoot_ai_runtime') is null as tables_absent,
      to_regprocedure('public.iniciar_envio_chatwoot_msg022(uuid,text,bigint)') is null as internal_absent,
      has_function_privilege('service_role','public.iniciar_envio_chatwoot(uuid,text,bigint)','execute') as old_grant,
      has_function_privilege('service_role','public.iniciar_ai_first_chatwoot(uuid,uuid,uuid,uuid,timestamptz,bigint,bigint)','execute') as grant_97`)).rows[0];
    assert.deepEqual(Object.values(rollback),[true,true,true,true]);
    console.log('Failed registry insert rolled back 98 DDL and ACL; 97 remained committed.');
    await p.query('alter table public.migracoes_aplicadas drop constraint reprova_98');
    assert.equal((await aplicarPendentes({client:p,pendentes:state.pendentes}))._tag,'ok');
    const complete=await check();
    assert.equal(complete._tag,'ok');
    assert.deepEqual(complete.value.pendentes,[]);
    const beforeRepeat=await capture();
    const repeat=await aplicarPendentes({client:p,pendentes:items.slice(100)});
    assert.equal(repeat.error?._tag,'MigracaoJaRegistrada');
    assert.equal((await capture()).fingerprint,beforeRepeat.fingerprint);
    const nativeAppFingerprint=catalogFingerprint(withoutRegistry(beforeRepeat.snapshot));
    assert.equal(nativeAppFingerprint,'4997c7f9f386268c9b82553c73fbd31350ef526b7cd16c1c6651bade4757a352');
    console.log('Retry completed 98 once; repeat refused without catalog change. Native candidate: '+nativeAppFingerprint);
  } finally {
    await p.end();
  }
});
