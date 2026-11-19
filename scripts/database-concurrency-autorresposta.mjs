import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { correr } from './database-concurrency-chatwoot.mjs';
import { aceitar, aplicar, comandoDaMensagem, novaOrganizacao, reivindicar } from './database-concurrency-consumidor-inbox-apoio.mjs';
import { err, ok } from './script-result.mjs';
import { createLocalDatabaseClient } from './local-database-client.mjs';

const mudar = 'select public.alterar_politica_autorresposta($1,$2,$3,$4,$5) as resultado';
const iniciar = 'select public.iniciar_envio_chatwoot($1,$2,$3) as resultado';
const registrar = 'select public.registrar_autorresposta_chatwoot($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) as resultado';

async function ator(admin) {
  const id = randomUUID();
  await admin.query('insert into auth.users (id, email) values ($1,$2)', [id, id + '@orbita.test']);
  return id;
}

function mensagemComData(id, criadaEm) {
  const comando = comandoDaMensagem(id, 50, 5);
  return { ...comando, mensagem: { ...comando.mensagem, criada_em: criadaEm } };
}

async function prepararConversa(admin, client, cenario) {
  const { org, conexao } = await novaOrganizacao(admin, 'm22-' + cenario);
  const owner = await ator(admin);
  await admin.query("insert into public.membros_organizacao (organizacao_id,user_id,papel) values ($1,$2,'owner')", [org, owner]);
  const evento = await aceitar(client, org, conexao, 'm22-' + cenario);
  const worker = 'm22-inbox-' + cenario;
  const lease = (await reivindicar(client, worker)).find((linha) => linha.evento_id === evento.evento_id);
  const { caso_id: caso } = await aplicar(client, lease.evento_id, worker, lease.fencing_token, mensagemComData(2200, '2026-11-17T00:00:01Z'));
  const { rows: [{ id_local: conversa }] } = await admin.query(
    "select id_local from public.chatwoot_conversations where conexao_id = $1 and id_externo = '50'", [conexao],
  );
  await admin.query(
    "insert into public.chatwoot_conversa_controle (organizacao_id, conversa_id_local, ownership_mode) values ($1,$2,'AI')",
    [org, conversa],
  );
  assert.equal((await client.query(mudar, [org, owner, true, 0, 'habilitar teste'])).rows[0].resultado, 'aplicado');
  await admin.query('insert into public.sac_executores_autorresposta values ($1,$2)', [org, owner]);
  const workerTriagem = 'm22-triagem-' + cenario;
  const fila = await client.query('select * from public.reivindicar_triagens_sac($1,20,120)', [workerTriagem]);
  const triagem = fila.rows.find((row) => row.caso_id === caso);
  assert.ok(triagem);
  const { rows: [{ inicio }] } = await client.query(
    "select public.iniciar_triagem_sac($1,$2,$3,10,'google','flash','v1',1) as inicio",
    [triagem.evento_id, workerTriagem, triagem.fencing_token],
  );
  assert.equal(inicio.resultado, 'iniciada');
  const { rows: [{ fim }] } = await client.query(
    `select public.concluir_triagem_sac($1,$2,$3,'concluida',null,
        '{"precisaDeHumano":false}'::jsonb,true,null,null,0::smallint,null,10) as fim`,
    [inicio.run_id, workerTriagem, triagem.fencing_token],
  );
  assert.equal(fim, 'concluida');
  const comando = randomUUID();
  return { org, owner, conexao, caso, comando, args: [org, owner, conversa, caso, comando, inicio.run_id, 'texto sintético', 1, 1, 0] };
}

async function claim(admin, client, fixture, worker) {
  assert.equal((await client.query(registrar, fixture.args)).rows[0].resultado, 'registrada');
  const { rows: [{ outbox_evento_id: evento }] } = await admin.query(
    'select outbox_evento_id from public.chatwoot_envios where organizacao_id=$1 and command_id=$2',
    [fixture.org, fixture.comando],
  );
  const { rows } = await client.query("select * from public.reivindicar_envios_chatwoot($1,50,120,'epoch',2)", [worker]);
  return [evento, worker, rows.find((row) => row.evento_id === evento).fencing_token];
}

async function corrida(clientes, a, b) {
  const resultado = await correr({
    ...clientes, sqlA: a[0], paramsA: a[1], sqlB: b[0], paramsB: b[1],
    timeoutDeObservacaoMs: 5000, rotulo: 'Autorresposta',
  });
  assert.equal(resultado._tag, 'ok', JSON.stringify(resultado));
  assert.equal(resultado.value.b.ok, true, JSON.stringify(resultado.value.b));
  return [resultado.value.a[0].resultado, resultado.value.b.linhas[0].resultado];
}

async function novaMensagem(client, fixture, worker, criadaEm) {
  const evento = await aceitar(client, fixture.org, fixture.conexao, worker);
  const lease = (await reivindicar(client, worker)).find((linha) => linha.evento_id === evento.evento_id);
  return [
    'select disposicao as resultado from public.aplicar_evento_inbox_chatwoot($1,$2,$3,$4::jsonb)',
    [lease.evento_id, worker, lease.fencing_token, JSON.stringify(mensagemComData(2201, criadaEm))],
  ];
}

async function ensaiar(clientes) {
  const { admin, clientA } = clientes;
  const ops = await ator(admin);
  await admin.query('insert into public.sac_operadores_autorresposta values ($1)', [ops]);
  assert.equal((await clientA.query(mudar, [null, ops, true, 0, 'habilitar teste'])).rows[0].resultado, 'aplicado');

  const um = await prepararConversa(admin, clientA, 'desligar');
  const primeiro = await claim(admin, clientA, um, 'm22-1');
  const desligar = [mudar, [um.org, um.owner, false, 1, 'desligar teste']];
  assert.deepEqual(await corrida(clientes, desligar, [iniciar, primeiro]), ['aplicado', 'posse_perdida']);

  const dois = await prepararConversa(admin, clientA, 'despachar');
  const segundo = await claim(admin, clientA, dois, 'm22-2');
  assert.deepEqual(await corrida(clientes, [iniciar, segundo], [mudar, [dois.org, dois.owner, false, 1, 'desligar teste']]),
    ['iniciado', 'aplicado']);
  const { rows } = await admin.query('select status from public.outbox_eventos where id = $1', [segundo[0]]);
  assert.equal(rows[0].status, 'in_flight');

  const tres = await prepararConversa(admin, clientA, 'registrar');
  assert.deepEqual(await corrida(clientes, [mudar, [tres.org, tres.owner, false, 1, 'desligar teste']], [registrar, tres.args]),
    ['aplicado', 'desligada']);
  assert.deepEqual(await corrida(clientes, [mudar, [um.org, um.owner, true, 2, 'religar teste']],
    [mudar, [um.org, um.owner, false, 2, 'comando concorrente']]), ['aplicado', 'conflito']);
  const quatro = await prepararConversa(admin, clientA, 'mensagem-primeiro');
  const leaseQuatro = await claim(admin, clientA, quatro, 'm22-4');
  const msgQuatro = await novaMensagem(clientA, quatro, 'm22-msg-4', '2026-11-17T00:00:01Z');
  assert.deepEqual(await corrida(clientes, msgQuatro, [iniciar, leaseQuatro]), ['mensagem_no_caso', 'invalidado']);
  const { rows: [previa] } = await admin.query(
    'select count(*)::int as tentativas from public.outbox_tentativas where evento_id = $1', [leaseQuatro[0]],
  );
  assert.equal(previa.tentativas, 0);

  const cinco = await prepararConversa(admin, clientA, 'mensagem-depois');
  const leaseCinco = await claim(admin, clientA, cinco, 'm22-5');
  const msgCinco = await novaMensagem(clientA, cinco, 'm22-msg-5', '2026-11-17T00:00:00Z');
  assert.deepEqual(await corrida(clientes, [iniciar, leaseCinco], msgCinco), ['iniciado', 'mensagem_no_caso']);
  const { rows: [emVoo] } = await admin.query('select status from public.outbox_eventos where id = $1', [leaseCinco[0]]);
  assert.equal(emVoo.status, 'in_flight');
  const { rows: [versao] } = await admin.query(
    "select ultima_mensagem_em > '2026-11-17T00:00:01Z'::timestamptz as avancou from public.sac_cases where id = $1",
    [cinco.caso],
  );
  assert.equal(versao.avancou, true);

}

export async function runAutorrespostaRaceRehearsal() {
  const clientes = [];
  try {
    for (const nome of ['admin', 'a', 'b']) {
      const client = createLocalDatabaseClient('orbita-autorresposta-' + nome);
      clientes.push(client);
      await client.connect();
    }
    const [admin, clientA, clientB] = clientes;
    // O runner de CI usa um banco descartável compartilhado com outras provas.
    await admin.query("update public.inbox_eventos_chatwoot set available_at = 'infinity' where status in ('received', 'failed')");
    await admin.query("update public.outbox_eventos set next_retry_at = 'infinity' where status in ('pending', 'failed_transient')");
    for (const client of [clientA, clientB]) {
      await client.query("set role service_role");
      await client.query("set request.jwt.claim.role = 'service_role'");
      await client.query("set statement_timeout = '15s'");
    }
    await ensaiar({ admin, clientA, clientB });
    return ok({ relato: 'MSG-022: seis corridas serializadas no PostgreSQL, incluindo mensagem no mesmo segundo e atrasada' });
  } catch (cause) {
    return err('AutorrespostaRehearsalFailed', 'Falha nas corridas de autorresposta', {}, cause);
  } finally {
    await Promise.all(clientes.map((client) => client.end()));
  }
}
