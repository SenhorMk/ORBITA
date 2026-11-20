// Run only against the authorized disposable Supabase gateway.
import assert from 'node:assert/strict';

const url = new URL(process.env.ORBITA_D084_GATEWAY ?? 'http://127.0.0.1:54321');
assert.equal(url.hostname, '127.0.0.1');
assert.equal(url.protocol, 'http:');
assert.equal(process.env.ORBITA_D084_DISPOSABLE, 'yes');
const service = process.env.ORBITA_D084_SERVICE_KEY;
const anon = process.env.ORBITA_D084_ANON_KEY;
assert.ok(service && anon, 'Set the two local test keys without printing them.');
const args = {
  p_org:'00000000-0000-4000-8000-000000000001',
  p_conexao:'00000000-0000-4000-8000-000000000002',
  p_executor:'00000000-0000-4000-8000-000000000003',
  p_pronto:false,
};
const rpc = (key) => fetch(new URL('/rest/v1/rpc/renovar_worker_ai_first',url), {
  method:'POST', headers:{ apikey:key, authorization:'Bearer '+key, 'content-type':'application/json' },
  body:JSON.stringify(args), redirect:'error', signal:AbortSignal.timeout(5000),
});
const permitido = await rpc(service);
assert.equal(permitido.status,200);
assert.equal(await permitido.json(),false);
const negado = await rpc(anon);
assert.ok([401,403,404].includes(negado.status));
console.log('PostgREST: named RPC visible to service_role and denied to anon.');
