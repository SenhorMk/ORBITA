import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { probe } from './chatwoot-probe.mjs';
import { chatwootFixture } from '../d084/chatwoot-fixture.mjs';

process.env.TS_NODE_PROJECT=fileURLToPath(new URL('../../scripts/tsconfig.worker.json',import.meta.url));
const require=createRequire(import.meta.url);
require('ts-node/register/transpile-only');
const { ChatwootAdapter }=require('../../src/services/chatwoot/chatwootAdapter.ts');

function setup({ assigned=null, wrongLabel=false, drift=false, roleChange=false, driftA=false } = {}) {
  const a={ conta:'1', inbox:'1', conversa:'221', token:'fixture-a', etiqueta:'orbita-d085-synthetic-a' };
  const b={ conta:'2', inbox:'2', conversa:'221', token:'fixture-b', etiqueta:'orbita-d085-synthetic-b' };
  const base={ a,b, origem:'http://127.0.0.1:49999', tecnico:17, modo:'ler',
    esperado:{status:'pending',responsavel:assigned} };
  const {state,fetchImpl:transport}=chatwootFixture();
  state.status='pending';
  state.assignee=assigned;
  const requests=[];
  const fetchImpl=async (raw,init)=>{
    const path=new URL(raw).pathname;
    const method=init?.method??'GET';
    requests.push([method,path]);
    if (path==='/api/v1/accounts/2/conversations/221') {
      assert.equal(method,'GET');
      assert.equal(init.headers.api_access_token,b.token);
      return Response.json({account_id:2,inbox_id:2,id:221, labels:[b.etiqueta],status:'open',meta:{},
        updated_at:drift && requests.length>1?2:1});
    }
    assert.equal(init.headers.api_access_token,a.token);
    if (roleChange && method==='POST') state.role='agent';
    const response=await transport(raw,init);
    if (method==='GET' && path==='/api/v1/accounts/1/conversations/221') {
      return Response.json({...await response.json(),labels:[wrongLabel?'different':a.etiqueta],
        updated_at:driftA && state.reads>1?2:1});
    }
    return response;
  };
  return {base,requests,state,opts:{fetchImpl,criarAdapter:ChatwootAdapter.forTesting}};
}

test('read-only probe confirms pending and writes to neither account', async ()=>{
  const f=setup();
  assert.equal((await probe(f.base,f.opts)).posts,0);
  assert.ok(f.requests.every(([m])=>m==='GET'));
});

test('approved fixture-only open preserves empty and existing assignee', async ()=>{
  for (const assigned of [null,31]) {
    const f=setup({assigned});
    const r=await probe({...f.base,modo:'abrir-fixture',autorizado:f.base.a.etiqueta},f.opts);
    assert.equal(r.depois.responsavel,assigned);
    assert.equal(r.sentinelaIntacta,true);
    assert.deepEqual(f.requests.filter(([m])=>m==='POST'),[['POST','/api/v1/accounts/1/conversations/221/toggle_status']]);
  }
});

test('unapproved write, non-loopback or wrong fixture label refuse any POST', async ()=>{
  const f=setup({wrongLabel:true});
  await assert.rejects(probe({...f.base,modo:'abrir-fixture'},f.opts),/autorização explícita/);
  await assert.rejects(probe({...f.base,origem:'https://unapproved.test'},f.opts));
  await assert.rejects(probe({...f.base,modo:'abrir-fixture',autorizado:f.base.a.etiqueta},f.opts),/fora da fixture/);
  assert.ok(f.requests.every(([m])=>m==='GET'));
  const mudou=setup({driftA:true});
  // The adapter normalizes a rejected transport read. The POST count proves
  // the probe stopped before changing status.
  await assert.rejects(probe({...mudou.base,modo:'abrir-fixture',autorizado:mudou.base.a.etiqueta},mudou.opts),/indisponível para projeção/);
  assert.ok(mudou.requests.every(([m])=>m==='GET'));
});

test('detects sentinel drift and does not retry a write after a role race', async ()=>{
  const quiet=setup({drift:true});
  await assert.rejects(probe(quiet.base,quiet.opts),/Sentinela/);
  const f=setup({roleChange:true});
  await assert.rejects(probe({...f.base,modo:'abrir-fixture',autorizado:f.base.a.etiqueta},f.opts),/responsável técnico/);
  assert.equal(f.requests.filter(([m])=>m==='POST').length,1);
  assert.equal(f.requests.filter(([,p])=>p.startsWith('/api/v1/accounts/2/')).length,2);
});
