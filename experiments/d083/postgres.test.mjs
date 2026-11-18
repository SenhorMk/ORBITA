import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { Client } = require('pg');
process.env.TS_NODE_PROJECT = fileURLToPath(new URL('../../scripts/tsconfig.worker.json', import.meta.url));
require('ts-node/register/transpile-only');
const { consumirAiFirstUmaVez } = require('../../src/services/chatwoot/workerAiFirst.ts');

const id = suffix => 'e2200000-0000-4000-8000-' + suffix.padStart(12, '0');
const db = { host: '127.0.0.1', port: 55482, user: 'postgres', database: 'orbita_d083', ssl: false };
const escopo = { p_org: id('a'), p_conexao: id('c1'), p_executor: id('a1') };
async function scalar(c, sql, values) {
  const { rows } = await c.query(sql, values);
  return rows[0] && Object.values(rows[0])[0];
}
async function esperarTrava(c, pid) {
  for (let i = 0; i < 60; i++) {
    if (await scalar(c, 'select wait_event_type from pg_stat_activity where pid=$1', [pid]) === 'Lock') return;
    await delay(20);
  }
  throw Error('A disputa não chegou a uma espera de lock.');
}

test('producer, durable projection, inbox barrier and MSG-022 on PostgreSQL', { timeout: 20000 }, async () => {
  assert.equal(process.env.ORBITA_D083_DISPOSABLE, 'yes');
  const [a,b,o] = [new Client(db),new Client(db),new Client(db)];
  await Promise.all([a.connect(), b.connect(), o.connect()]);
  try {
    const fixture = readFileSync(new URL('../../supabase/tests/final/autorresposta_sac.test.sql', import.meta.url), 'utf8');
    await a.query(fixture.slice(fixture.indexOf('insert into auth.users'), fixture.indexOf('select ok(not has_function_privilege'))
      .replace("jsonb_build_object('precisaDeHumano', p_humano)", "jsonb_build_object('precisaDeHumano', p_humano, 'intencao', 'outro')"));
    for (const c of [a,b,o]) await c.query("set request.jwt.claim.role='service_role'; set statement_timeout='6s'");
    const { p_org: org, p_conexao: conexao, p_executor: executor } = escopo;
    await a.query('insert into public.sac_executores_autorresposta values ($1,$2)', [org,executor]);
    await a.query("insert into public.chatwoot_ai_runtime values ($1,$2,$3,now()-interval '2 minutes',true)",
      [conexao,org,executor]);
    const banco = {
      async rpc(nome,args) {
        assert.match(nome,/^(renovar_worker|escalonar_triagem|reivindicar_(projecao|geracao)|iniciar_projecao|concluir_(projecao|geracao))_ai_first$/);
        await a.query('set role service_role');
        try {
          const pares=Object.entries(args);
          const chamada=pares.map(([k],i) => k+' => $'+(i+1)).join(',');
          return { data: await scalar(a,'select public.'+nome+'('+chamada+')',pares.map(([,v])=>v)), error:null };
        } finally { await a.query('reset role'); }
      },
    };
    const inbox = (m, conv=221) => scalar(a, 'select pg_temp.inbox($1,$2,$3,$4,clock_timestamp())', [org,conexao,m,conv]);
    const nascimento=Math.floor(Date.now()/1000);
    const delivery = (c, tipo, key, conv=221) => scalar(c,
      'select evento_id from public.aceitar_entrega_inbox_chatwoot($1,$2,null,1,null,$3,$4,$5)',
      [org,conexao,key,tipo,{event:tipo,account:{id:1},conversation:{id:conv,inbox_id:1,
        assignee_id:null,created_at:nascimento}}]);
    async function applyAsObservation(event, worker) {
      const token = await scalar(a, 'select fencing_token from public.reivindicar_eventos_inbox_chatwoot($1,50,60,\'epoch\') where evento_id=$2',
        [worker,event]);
      assert.ok(token);
      await scalar(a,`select disposicao from public.aplicar_evento_inbox_chatwoot(
        $1,$2,$3,jsonb_build_object('evento', (select event_type from public.inbox_eventos_chatwoot where id=$1),'acao','ignorar'))`,
        [event,worker,token]);
    }
    let status='open';
    const writes=[];
    let modelos=0;
    const entradas=[];
    let falharRecibo=false;
    let leituras=0;
    const canal={
      async pronto(){return true;},
      async ler(_,item){leituras++;return {conta:item.account_id,inbox:item.inbox_id,conversa:item.id_externo,status,responsavel:null};},
      async alterarSemAtribuir(_,item,alvo){writes.push([item.id_externo,alvo]);status=alvo;if(falharRecibo)throw Error('timeout');},
    };
    const modelo={provedor:'fake',async gerar(_,entrada){modelos++;entradas.push(entrada);return {texto:'Resposta sintética para seu atendimento.'};}};
    const pass = (m=modelo) => consumirAiFirstUmaVez({escopo,banco,canal,modelo:m,habilitado:true});
    assert.equal((await pass(null)).estado,'desligado');
    assert.equal(await inbox(2201),'caso_aberto');
    const conv=await scalar(a,'select pg_temp.conversa(221)');
    const criacao=await delivery(a,'conversation_created','d083-nova');
    await applyAsObservation(criacao,'inbox-1');
    await scalar(a,'select pg_temp.criar_run(221)');
    assert.equal((await pass()).estado,'sem_geracao');
    assert.equal(modelos,0);
    assert.equal(await scalar(a,'select pg_temp.mudar(null,$1,true,0)',[id('f1')]),'aplicado');
    assert.equal(await scalar(a,'select pg_temp.mudar($1,$2,true,0)',[org,executor]),'aplicado');
    falharRecibo=true;
    assert.equal((await pass()).projecao,'incerto');
    await a.query("update public.chatwoot_ai_projecao set ate=now()-interval '1 second'");
    falharRecibo=false;
    assert.equal((await pass()).geracao,'registrada');
    assert.deepEqual(writes,[['221','pending']]);
    assert.equal((await pass()).estado,'sem_geracao');
    assert.equal(modelos,1);
    assert.equal(await scalar(a,'select responsavel_id from public.chatwoot_conversa_controle where conversa_id_local=$1',[conv]),null);

    const claimant = async (nome) => (await a.query(
      `select r.evento_id,r.fencing_token from public.reivindicar_envios_chatwoot($1,50,120,'epoch',2) r
        join public.chatwoot_envios e on e.outbox_evento_id=r.evento_id where e.autorresposta_run_id is not null`,[nome])).rows[0];
    const envio=await claimant('envio-1');
    assert.ok(envio);
    const iniciar=(c,e,nome)=>scalar(c,'select public.iniciar_envio_chatwoot($1,$2,$3)',[e.evento_id,nome,e.fencing_token]);
    await b.query('begin');
    const atualizacao=await delivery(b,'conversation_updated','d083-status');
    const resultado=iniciar(a,envio,'envio-1');
    await esperarTrava(o,a.processID);
    await b.query('commit');
    assert.equal(await resultado,'aguardando_ai_first');
    assert.equal(await iniciar(a,envio,'envio-1'),'aguardando_ai_first');
    assert.equal(await delivery(a,'conversation_updated','d083-status'),atualizacao);

    // The first inbox process took its lease and died. Only the restarted
    // worker can apply the event; production reclaims naturally after TTL.
    const velho=await scalar(a,`select fencing_token from public.reivindicar_eventos_inbox_chatwoot(
        'inbox-caido',50,60,'epoch') where evento_id=$1`,[atualizacao]);
    assert.ok(velho);
    await a.query("update public.inbox_eventos_chatwoot set lease_expires_at=now()-interval '1 second' where id=$1",[atualizacao]);
    await applyAsObservation(atualizacao,'inbox-2');
    assert.equal(await iniciar(a,envio,'envio-1'),'aguardando_ai_first');
    const antes=leituras;
    assert.equal((await pass()).projecao,'ok');
    assert.ok(leituras>antes);
    assert.equal(writes.length,1);
    assert.equal((await pass(null)).estado,'desligado');
    assert.equal(await iniciar(a,envio,'envio-1'),'aguardando_ai_first');
    await pass();
    await a.query('begin');
    assert.equal(await iniciar(a,envio,'envio-1'),'iniciado');
    const segundo=iniciar(b,envio,'envio-1');
    await esperarTrava(o,b.processID);
    await a.query('commit');
    assert.equal(await segundo,'posse_perdida');
    assert.equal(await scalar(a,`select status from public.concluir_envio_chatwoot(
      $1,'envio-1',$2,'desconhecido',null,'timeout')`,[envio.evento_id,envio.fencing_token]),'unknown');
    await assert.rejects(a.query('select public.autorizar_replay_outbox($1,$2,$3)', [org,envio.evento_id,executor]), {code:'55000'});
    assert.equal(await scalar(a,`select public.resolver_evento_desconhecido_outbox($1,$2,$3,'confirmado','99123')`,
      [org,envio.evento_id,executor]),'sent');

    const control=(acao,versao,cmd,nota)=>scalar(a,`select resultado from public.alterar_controle_atendimento_chatwoot(
      $1,$2,$3,$4,$5,$6,$7)`,[org,executor,conv,id(cmd),acao,versao,nota]);
    assert.equal(await inbox(2202),'mensagem_no_caso');
    await scalar(a,"select pg_temp.criar_run(221,'concluida',true)");
    const escalonado=await pass();
    assert.equal(escalonado.escalonamento,'aplicado');
    assert.equal(escalonado.projecao,'ok');
    assert.equal(await control('assumir',2,'813',null),'aplicado');
    assert.equal(await scalar(a,`select resultado from public.registrar_envio_chatwoot($1,$2,$3,$4,'humana')`,
      [org,executor,conv,id('814')]),'registrado');
    assert.equal(await control('devolver',3,'817','Ainda pendente.'),'automacao_inativa');
    const humano=await scalar(a,"select pg_temp.evento('814')");
    const tokenHumano=await scalar(a,`select fencing_token from public.reivindicar_envios_chatwoot(
      'human',50,120,'epoch',2) where evento_id=$1`,[humano]);
    assert.equal(await iniciar(a,{evento_id:humano,fencing_token:tokenHumano},'human'),'iniciado');
    assert.equal(await scalar(a,`select status from public.concluir_envio_chatwoot(
      $1,'human',$2,'confirmado','99124')`,[humano,tokenHumano]),'sent');
    assert.equal(await control('devolver',3,'815','Atendimento contextualizado.'),'aplicado');
    assert.equal((await pass()).estado,'sem_geracao');
    assert.equal(await inbox(2203),'mensagem_no_caso');
    await scalar(a,'select pg_temp.criar_run(221)');
    assert.equal((await pass()).geracao,'registrada');
    assert.deepEqual(writes,[['221','pending'],['221','open'],['221','pending']]);
    assert.equal(modelos,2);
    assert.match(entradas.at(-1),/Atendimento contextualizado/);
    const envio2=await claimant('envio-2');
    const bEvent=await scalar(b,`select evento_id from public.aceitar_entrega_inbox_chatwoot(
        $1,$2,null,1,null,'b-event','conversation_updated',$3)`,
      [id('b'),id('d1'),{conversation:{id:221}}]);
    assert.ok(bEvent);
    assert.equal(await scalar(a,'select public.ai_inbox_pendente($1,$2,\'221\')',[org,conexao]),false);
    assert.equal(await control('assumir',4,'816',null),'aplicado');
    assert.match(await iniciar(a,envio2,'envio-2'),/^(invalidado|posse_perdida)$/);
    assert.equal(await scalar(a,'select status from public.outbox_eventos where id=$1',[envio2.evento_id]),'dead_letter');
    assert.equal(await scalar(a,`select has_function_privilege('service_role',
        'public.iniciar_envio_chatwoot_msg022(uuid,text,bigint)','execute')`),false);
    assert.equal(await scalar(a,`select has_function_privilege('service_role',
        'public.registrar_autorresposta_chatwoot(uuid,uuid,uuid,uuid,uuid,uuid,text,bigint,bigint,bigint)','execute')`),false);
    assert.equal(await control('devolver',5,'818','Resumo para o teste de divergência.'),'aplicado');
    assert.equal((await pass()).projecao,'ok');
    const divergencia=await delivery(a,'conversation_updated','d083-divergente');
    await applyAsObservation(divergencia,'inbox-3');
    status='open';
    const leitura=await scalar(a,'select public.reivindicar_projecao_ai_first($1,$2,$3)',[org,conexao,executor]);
    assert.equal(leitura.somente_leitura,true);
    await a.query("update public.chatwoot_ai_projecao set ate=now()-interval '1 second'");
    const antesDivergencia=writes.length;
    assert.equal((await pass()).projecao,'contido');
    assert.equal(writes.length,antesDivergencia);
    assert.equal(await scalar(a,'select ownership_mode from public.chatwoot_conversa_controle where conversa_id_local=$1',[conv]),'HUMAN_REQUIRED');
    console.log('Observed two PostgreSQL lock waits: inbox admission vs send, and simultaneous dispatch.');
  } finally { await Promise.all([a.end(),b.end(),o.end()]); }
});
