import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { Client } = require(process.env.ORBITA_D082_PG_MODULE || 'pg');
process.env.TS_NODE_PROJECT = new URL('../../scripts/tsconfig.worker.json', import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, '');
require('ts-node/register/transpile-only');
const { ativarAposProjecao, produzirIntencaoAiFirst, planejarProjecao } = require('../../src/services/chatwoot/aiFirst.ts');
const prefix = 'e2200000-0000-4000-8000-';
const id = suffix => prefix + suffix.padStart(12, '0');
const org = id('a');
const owner = id('a1');
const connection = id('c1');
const globalOperator = id('f1');
const db = { host: '127.0.0.1', port: 55482, user: 'postgres', database: 'orbita_d082', ssl: false };

async function scalar(client, sql, values) {
  const { rows } = await client.query(sql, values);
  return rows[0] && Object.values(rows[0])[0];
}

async function waitingOnLock(observer, other) {
  for (let n = 0; n < 40; n++) {
    if (await scalar(observer, 'select wait_event_type from pg_stat_activity where pid = $1', [other.processID]) === 'Lock') return;
    await delay(25);
  }
  throw Error('No PostgreSQL lock contention observed');
}

test('D08.2 over real PostgreSQL: inbox → bootstrap → fenced AI → human → handback', { timeout: 15000 }, async () => {
  assert.equal(process.env.ORBITA_D082_DISPOSABLE, 'yes', 'Use a new local lab only');
  const clients = [new Client(db), new Client(db), new Client(db)];
  const [a, b, observer] = clients;
  await Promise.all(clients.map(c => c.connect()));
  try {
    // Reuse exclusively the existing MSG-022 fixture setup, without pgTAP.
    const full = readFileSync(new URL('../../supabase/tests/final/autorresposta_sac.test.sql', import.meta.url), 'utf8');
    const first = full.indexOf('insert into auth.users');
    const last = full.indexOf("select ok(not has_function_privilege");
    assert.ok(first >= 0 && last > first);
    await a.query(full.slice(first, last));
    for (const c of clients) {
      await c.query("set request.jwt.claim.role = 'service_role'");
      await c.query("set statement_timeout = '5s'");
    }
    await a.query('insert into public.sac_executores_autorresposta values ($1,$2)', [org, owner]);
    const cutoff = await scalar(a, "select now() - interval '2 minutes'");
    const payload = JSON.stringify({ event: 'conversation_created', account: { id: 1 },
      conversation: { id: 221, inbox_id: 1, assignee_id: null, created_at: Math.floor(Date.now()/1000) } });
    assert.equal(await scalar(a, "select pg_temp.inbox($1,$2,2201,221,now())", [org, connection]), 'caso_aberto');
    const conv = await scalar(a, 'select pg_temp.conversa(221)');
    const caseId = await scalar(a, 'select pg_temp.caso(221)');
    const autorizacao = { organizacao: org, executor: owner, conversa: conv, versaoGlobal: 1, versaoOrganizacao: 1 };
    const sqlByRpc = {
      iniciar_ai_first_chatwoot: 'select public.iniciar_ai_first_chatwoot($1,$2,$3,$4,$5,$6,$7)',
      registrar_autorresposta_chatwoot: 'select public.registrar_autorresposta_chatwoot($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    };
    const banco = {
      async rpc(name, args) {
        const data = await scalar(a, sqlByRpc[name], Object.values(args));
        return { data, error: null };
      },
    };
    const activate = (event, executor = owner, tenant = org) => scalar(a,
      'select public.iniciar_ai_first_chatwoot($1,$2,$3,$4,$5,1,1)', [tenant, executor, conv, event, cutoff]);
    const event = await scalar(a, `select evento_id from public.aceitar_entrega_inbox_chatwoot(
        $1,$2,null,1,null,'d082-created','conversation_created',$3::jsonb)`, [org, connection, payload]);
    const duplicate = await scalar(a, `select evento_id from public.aceitar_entrega_inbox_chatwoot(
        $1,$2,null,1,null,'d082-created','conversation_created',$3::jsonb)`, [org, connection, payload]);
    assert.equal(event, duplicate);
    assert.equal(await activate(event), 'politica_obsoleta');
    assert.equal(await scalar(a, 'select pg_temp.mudar(null,$1,true,0)', [globalOperator]), 'aplicado');
    assert.equal(await scalar(a, 'select pg_temp.mudar($1,$2,true,0)', [org, owner]), 'aplicado');
    assert.equal(await activate(event, id('a2')), 'executor_nao_autorizado');
    assert.equal(await activate(id('999')), 'evidencia_insuficiente');
    assert.equal(await activate(event, owner, id('b')), 'executor_nao_autorizado');
    await a.query('insert into public.sac_executores_autorresposta values ($1,$2)', [id('b'), id('b1')]);
    assert.equal(await scalar(a, 'select pg_temp.mudar($1,$2,true,0)', [id('b'), id('b1')]), 'aplicado');
    const bConnection = id('d1');
    const bPayload = JSON.stringify({ ...JSON.parse(payload), conversation: { ...JSON.parse(payload).conversation, id: 222 } });
    const bProof = await scalar(a, `select evento_id from public.aceitar_entrega_inbox_chatwoot(
      $1,$2,null,1,null,'d082-created','conversation_created',$3::jsonb)`, [id('b'), bConnection, bPayload]);
    assert.equal(await scalar(a, 'select pg_temp.conversa(222)'), null);
    assert.equal(await scalar(a, 'select pg_temp.inbox($1,$2,2301,222,now())', [id('b'), bConnection]), 'caso_aberto');
    const bConv = await scalar(a, 'select pg_temp.conversa(222)');
    const bActivate = proof => scalar(a, 'select public.iniciar_ai_first_chatwoot($1,$2,$3,$4,$5,1,1)',
      [id('b'), id('b1'), bConv, proof, cutoff]);
    assert.equal(await bActivate(event), 'evidencia_insuficiente');
    assert.equal(await bActivate(bProof), 'ativada');
    await a.query('set role service_role');
    const pending = { conversa: conv, status: 'pending', assigneeId: null };
    assert.equal(await ativarAposProjecao(banco, autorizacao, event, cutoff.toISOString(), { ...pending, assigneeId: 13 }), 'projecao_nao_confirmada');
    assert.equal(planejarProjecao('AI', { ...pending, status: 'open' }), 'conter');
    assert.equal(planejarProjecao('HUMAN', pending), 'projetar_open');
    assert.equal(await ativarAposProjecao(banco, autorizacao, event, cutoff.toISOString(), pending), 'ativada');
    assert.equal(await activate(event), 'existente');
    assert.equal(await scalar(a, 'select responsavel_id from public.chatwoot_conversa_controle where conversa_id_local=$1', [conv]), null);
    await a.query('reset role');
    assert.equal(await scalar(a, `select has_function_privilege('authenticated',
      'public.iniciar_ai_first_chatwoot(uuid,uuid,uuid,uuid,timestamptz,bigint,bigint)','execute')`), false);
    const run = await scalar(a, 'select pg_temp.criar_run(221)');
    const queue = (key, version, classification = run) => scalar(a,
      `select public.registrar_autorresposta_chatwoot($1,$2,$3,$4,$5,$6,'resposta sintetica',1,1,$7)`,
      [org, owner, conv, caseId, id(key), classification, version]);
    assert.equal(await queue('101', 1, id('999')), 'run_inelegivel');
    assert.equal(await queue('101', 1), 'registrada');
    assert.equal(await queue('101', 1), 'existente');
    assert.equal(await queue('102', 1), 'registrada');
    const { rows: claimed } = await a.query("select evento_id,fencing_token from public.reivindicar_envios_chatwoot('d082',50,120,'epoch',2)");
    const event1 = await scalar(a, "select pg_temp.evento('101')");
    const event2 = await scalar(a, "select pg_temp.evento('102')");
    const token = eventId => claimed.find(row => row.evento_id === eventId).fencing_token;
    const dispatch = (c, eventId) => scalar(c, "select public.iniciar_envio_chatwoot($1,'d082',$2)", [eventId, token(eventId)]);
    const control = (c, key, action, version, note) => scalar(c,
      'select resultado from public.alterar_controle_atendimento_chatwoot($1,$2,$3,$4,$5,$6,$7)',
      [org, owner, conv, id(key), action, version, note]);

    await a.query('begin');
    assert.equal(await dispatch(a, event1), 'iniciado');
    const rival = dispatch(b, event1);
    await waitingOnLock(observer, b);
    await a.query('commit');
    assert.equal(await rival, 'posse_perdida');
    assert.equal(await scalar(a, 'select count(*)::int from public.outbox_tentativas where evento_id=$1', [event1]), 1);
    console.log('Observed two dispatch writers contending on one outbox row');

    await a.query('begin');
    assert.equal(await control(a, '501', 'assumir', 1, null), 'aplicado');
    const afterTakeover = dispatch(b, event2);
    await waitingOnLock(observer, b);
    await a.query('commit');
    assert.match(await afterTakeover, /^(invalidado|posse_perdida)$/);
    assert.equal(await scalar(a, "select pg_temp.estado('102')"), 'dead_letter');
    assert.equal(await scalar(a, "select pg_temp.estado('101')"), 'in_flight');
    assert.equal(await activate(event), 'existente');
    assert.equal(await scalar(a, 'select ownership_mode from public.chatwoot_conversa_controle where conversa_id_local=$1', [conv]), 'HUMAN');
    console.log('Observed takeover holding its lock while a second dispatch waited');
    assert.equal(await control(a, '502', 'devolver', 1, 'summary'), 'conflito_versao');
    assert.equal(await scalar(a, `select status from public.concluir_envio_chatwoot($1,'d082',$2,
        'desconhecido',null,'timeout')`, [event1, token(event1)]), 'unknown');
    await assert.rejects(a.query('select public.autorizar_replay_outbox($1,$2,$3)', [org, event1, owner]), { code: '55000' });
    assert.equal(await scalar(a, `select public.resolver_evento_desconhecido_outbox(
        $1,$2,$3,'confirmado','88123')`, [org, event1, owner]), 'sent');
    assert.equal(await scalar(a, `select resultado from public.registrar_envio_chatwoot(
        $1,$2,$3,$4,'humana')`, [org, owner, conv, id('103')]), 'registrado');
    const human = await scalar(a, "select pg_temp.evento('103')");
    const humanToken = await scalar(a, `select fencing_token from public.reivindicar_envios_chatwoot(
        'humano',50,120,'epoch',2) where evento_id=$1`, [human]);
    assert.equal(await scalar(a, "select public.iniciar_envio_chatwoot($1,'humano',$2)", [human, humanToken]), 'iniciado');
    assert.equal(await scalar(a, `select status from public.concluir_envio_chatwoot(
        $1,'humano',$2,'confirmado','88124')`, [human, humanToken]), 'sent');
    assert.equal(await control(a, '503', 'devolver', 2, 'summary'), 'aplicado');
    assert.equal(await queue('104', 2), 'obsoleta');
    assert.equal(await scalar(a, 'select pg_temp.inbox($1,$2,2202,221,now())', [org, connection]), 'mensagem_no_caso');
    const nextRun = await scalar(a, 'select pg_temp.criar_run(221)');
    const contexto = { autorizacao, caso: caseId, run: nextRun, versaoControle: 3, marca: 'inbound-2202',
      intencao: 'outro', mensagens: [{ conteudo: 'Preciso de ajuda com a minha compra', criadaEm: new Date().toISOString() }] };
    const modelo = { provedor: 'fake', gerar: async () => ({ texto: 'Como posso ajudar com a compra?' }) };
    await a.query('set role service_role');
    assert.equal(await produzirIntencaoAiFirst(banco, async () => contexto, modelo), 'registrada');
    assert.equal(await produzirIntencaoAiFirst(banco, async () => contexto, modelo), 'existente');
    await a.query('reset role');
    assert.equal(await scalar(a, 'select pg_temp.mudar($1,$2,false,1)', [org, owner]), 'aplicado');
    assert.equal(await scalar(a, `select o.status from public.outbox_eventos o
      join public.chatwoot_envios e on e.outbox_evento_id=o.id where e.autorresposta_run_id=$1`, [nextRun]), 'dead_letter');
    assert.equal(await queue('105', 3, nextRun), 'desligada');
  } finally {
    await Promise.all(clients.map(c => c.end()));
  }
});
