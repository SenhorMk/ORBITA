import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chatwootFixture } from './chatwoot-fixture.mjs';

process.env.TS_NODE_PROJECT = fileURLToPath(new URL('../../scripts/tsconfig.worker.json', import.meta.url));
const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
const { ChatwootAdapter } = require('../../src/services/chatwoot/chatwootAdapter.ts');
const adapter = ChatwootAdapter.forTesting({ apiUrl: 'https://chatwoot.test', apiToken: 'synthetic', accountId: '1', conexaoId: 'fixture' });
const set = (fixture, alvo) => adapter.projetarStatusComoAdministrador('221', 1, '1', 17, alvo, fixture.fetchImpl);

test('CE equivalent Administrator moves pending/open with no human assignee', async () => {
  const f = chatwootFixture();
  await set(f,'pending');
  await set(f,'open');
  await set(f,'pending');
  await set(f,'pending');
  assert.deepEqual(f.state.writes.map(([,s]) => s), ['pending','open','pending']);
  assert.equal(f.state.assignee,null);
});

test('Agent in target account would self-assign, adapter does not write', async () => {
  const f = chatwootFixture();
  f.state.status='pending';
  f.state.role='agent';
  await f.fetchImpl('https://chatwoot.test/api/v1/accounts/1/conversations/221/toggle_status',
    { method:'POST', body:JSON.stringify({status:'open'}) });
  assert.equal(f.state.assignee,17);
  f.state.status='pending';
  f.state.assignee=null;
  f.state.writes.length=0;
  await assert.rejects(set(f,'open'), /Administrador/);
  assert.deepEqual(f.state.writes,[]);
});

test('Administrator preserves existing human on open and refuses assigned handback', async () => {
  const f=chatwootFixture();
  f.state.status='pending';
  f.state.assignee=31;
  await set(f,'open');
  assert.equal(f.state.assignee,31);
  await assert.rejects(set(f,'pending'), /não pode/);
  assert.equal(f.state.writes.length,1);
});

test('autoassignment, cross-account detail and technical assignee are rejected', async () => {
  for (const [field,value] of [['automatic',true],['badAccount',true],['assignee',17]]) {
    const f=chatwootFixture();
    f.state.status='pending';
    f.state[field]=value;
    await assert.rejects(set(f,'open'));
    assert.deepEqual(f.state.writes,[]);
  }
});

test('role change after the preflight is detected by readback, without an assignments write', async () => {
  const f=chatwootFixture();
  f.state.status='pending';
  const fetchImpl=async (url, init) => {
    if (init?.method==='POST') f.state.role='agent';
    return f.fetchImpl(url,init);
  };
  await assert.rejects(adapter.projetarStatusComoAdministrador('221',1,'1',17,'open',fetchImpl),
    /responsável técnico/);
  assert.equal(f.state.assignee,17, 'this race is outside the adapter transaction');
  assert.deepEqual(f.state.writes,[['221','open']]);
});
