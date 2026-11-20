import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const positive = /^[1-9]\d{0,8}$/u;
const labels = /^orbita-d085-[a-z0-9-]{8,48}$/u;
const statuses = new Set(['pending','open']);
const requestOptions = { cache:'no-store', redirect:'error' };

function parseFixture(f) {
  assert.ok(positive.test(f.conta) && positive.test(f.inbox) && positive.test(f.conversa), 'IDs inválidos');
  assert.ok(labels.test(f.etiqueta) && f.token, 'Fixture ou credencial ausente');
  return { ...f, path:`/api/v1/accounts/${f.conta}/conversations/${f.conversa}` };
}

export async function probe(input, { fetchImpl = fetch, criarAdapter } = {}) {
  const { a, b, modo, esperado, autorizado } = input;
  const url = new URL(input.origem);
  assert.equal(url.hostname,'127.0.0.1');
  assert.equal(url.pathname,'/');
  assert.ok(!url.username && !url.password && !url.hash && !url.search);
  assert.ok(['http:','https:'].includes(url.protocol));
  assert.ok(['ler','abrir-fixture'].includes(modo));
  const alvo=parseFixture(a);
  const sentinela=parseFixture(b);
  assert.notEqual(alvo.conta,sentinela.conta);
  assert.notEqual(alvo.etiqueta,sentinela.etiqueta);
  assert.notEqual(alvo.token,sentinela.token);
  assert.ok(positive.test(String(input.tecnico)), 'ID técnico inválido');
  assert.ok(statuses.has(esperado.status));
  assert.ok(esperado.responsavel===null || /^[1-9]\d{0,8}$/u.test(String(esperado.responsavel)));
  if (modo==='abrir-fixture') {
    assert.equal(autorizado,alvo.etiqueta,'Escrita exige autorização explícita para a fixture');
    assert.equal(esperado.status,'pending');
  }

  function conferir(f, d) {
    assert.ok(String(d?.account_id)===f.conta && String(d?.inbox_id)===f.inbox
      && String(d?.id)===f.conversa && Array.isArray(d?.labels) && d.labels.includes(f.etiqueta),
      'Conta, inbox, conversa ou etiqueta fora da fixture');
    assert.ok(d.meta && typeof d.meta==='object' && !Array.isArray(d.meta), 'Metadados ausentes');
    const id=d.meta.assignee?.id??null;
    if (id!==null) assert.ok(Number.isSafeInteger(id) && id>0 && d.meta.assignee_type==='User',
      'Tipo de responsável divergente');
    else assert.ok(d.meta.assignee_type==null, 'Tipo de responsável inconsistente');
    assert.ok(statuses.has(d.status));
    assert.ok(Number.isFinite(d.updated_at), 'Revisão ausente');
    return { conta:f.conta,inbox:f.inbox,conversa:f.conversa,status:d.status,responsavel:id,updatedAt:d.updated_at };
  }
  async function ler(f) {
    const r=await fetchImpl(url.origin+f.path,{...requestOptions, method:'GET',
      headers:{api_access_token:f.token},signal:AbortSignal.timeout(3000)});
    assert.ok(r.ok,'Leitura da fixture recusada');
    return conferir(f,await r.json());
  }
  const antesB=await ler(sentinela);
  const antes=await ler(alvo);
  assert.ok(antes.status===esperado.status && antes.responsavel===esperado.responsavel
    && antes.responsavel!==input.tecnico, 'Estado inicial divergente');
  let depois=antes;
  let posts=0;
  try {
    if (modo==='abrir-fixture') {
      assert.equal(typeof criarAdapter,'function');
      const guard=async (raw,init) => {
        const parsed=new URL(String(raw));
        const method=init?.method??'GET';
        assert.ok(parsed.origin===url.origin && !parsed.search && !parsed.hash, 'Destino fora do loopback aprovado');
        if (method==='POST') {
          assert.equal(parsed.pathname,alvo.path+'/toggle_status');
          assert.equal(JSON.parse(init.body).status,'open');
          assert.equal(posts,0,'Somente um POST é permitido');
          posts++;
        } else {
          assert.equal(method,'GET');
          assert.ok(['/api/v1/profile',`/api/v1/accounts/${alvo.conta}/inboxes/${alvo.inbox}`,alvo.path].includes(parsed.pathname));
        }
        const r=await fetchImpl(raw,{...init,...requestOptions});
        if (r.ok && method==='GET' && parsed.pathname===alvo.path) {
          const atual=conferir(alvo,await r.clone().json());
          if (posts===0) assert.deepEqual(atual,antes,'A fixture mudou antes da escrita');
        }
        return r;
      };
      const adapter=criarAdapter({apiUrl:url.origin,apiToken:alvo.token,accountId:alvo.conta,conexaoId:'d085-probe'});
      await adapter.projetarStatusComoAdministrador(alvo.conversa,Number(alvo.inbox),alvo.conta,input.tecnico,'open',guard);
      depois=await ler(alvo);
      assert.ok(depois.status==='open' && depois.responsavel===antes.responsavel,
        'Status ou atribuição divergente após abertura');
    }
  } finally {
    const depoisB=await ler(sentinela);
    assert.deepEqual(depoisB,antesB,'Sentinela da outra conta divergiu');
  }
  return { modo, antes, depois, posts, sentinelaIntacta:true };
}

async function main(env, args) {
  assert.equal(env.ORBITA_D085_AUTORIZADO_LEITURA,'sim');
  assert.ok(args.length<=1);
  const input={
    modo:args[0]??'ler', origem:env.ORBITA_D085_ORIGEM,
    tecnico:Number(env.ORBITA_D085_TECNICO), autorizado:env.ORBITA_D085_AUTORIZADO_ESCRITA,
    esperado:{status:env.ORBITA_D085_STATUS, responsavel:env.ORBITA_D085_ASSIGNEE==='nenhum'
      ? null : Number(env.ORBITA_D085_ASSIGNEE)},
  };
  for (const lado of ['A','B']) {
    const read = name => env[`ORBITA_D085_${lado}_${name}`];
    input[lado.toLowerCase()]={ conta:read('CONTA'),inbox:read('INBOX'),conversa:read('CONVERSA'),
      etiqueta:read('ETIQUETA'),token:read('TOKEN_DESCARTAVEL') };
  }
  let criarAdapter;
  if (input.modo==='abrir-fixture') {
    process.env.TS_NODE_PROJECT=fileURLToPath(new URL('../../scripts/tsconfig.worker.json',import.meta.url));
    const require=createRequire(import.meta.url);
    require('ts-node/register/transpile-only');
    criarAdapter=require('../../src/services/chatwoot/chatwootAdapter.ts').ChatwootAdapter.forTesting;
  }
  console.log(JSON.stringify(await probe(input,{criarAdapter}),null,2));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href===import.meta.url) {
  main(process.env,process.argv.slice(2)).catch(() => {
    console.error('Ensaio contido. Pare, confira a fixture e concilie qualquer POST sem confirmação antes de prosseguir.');
    process.exitCode=1;
  });
}
