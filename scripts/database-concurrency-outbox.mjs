import { createLocalDatabaseClient } from './local-database-client.mjs';
import { err, ok } from './script-result.mjs';
import { esperar, observarBloqueioNoPostgres } from './database-concurrency.mjs';

/**
 * MSG-007, migration 86. Prova contra Postgres real, com conexões como
 * `service_role` e a barreira determinística por `pg_stat_activity`:
 *
 * 1. dois workers reivindicam lotes ao mesmo tempo: o segundo pula as linhas
 *    travadas pelo primeiro (`SKIP LOCKED`) e os lotes são disjuntos;
 * 2. o reaper leva um `in_flight` vencido para `unknown` e segura a linha; o
 *    worker antigo, com recibo tardio, espera e, depois do commit, é recusado
 *    pelo compare-and-set — o evento continua `unknown`;
 * 3. duas pessoas autorizam o mesmo replay: a segunda espera e, depois do
 *    commit, recebe 55000 — um único replay;
 * 4. contraprova: com a conclusão sem comparar o fencing token, o mesmo worker
 *    id com o token antigo devolve à fila um despacho que está em voo com o
 *    token vigente (o próximo claim o reenviaria). O ensaio detecta, desfaz a
 *    sabotagem e confirma a recusa.
 */

const ORG = 'e7200000-0000-4000-8000-00000000000a';
const DONO = 'e7200000-0000-4000-8000-0000000000a1';
const GESTOR = 'e7200000-0000-4000-8000-0000000000a2';

async function semear(client) {
  await client.query(
    `insert into auth.users (id, email) values ($1, 'dono-m7-conc@orbita.test'), ($2, 'gestor-m7-conc@orbita.test')`,
    [DONO, GESTOR],
  );
  await client.query("insert into public.organizacoes (id, nome, slug, status) values ($1, 'Org M7 Conc', 'org-m7-conc', 'active')", [ORG]);
  await client.query(
    "insert into public.membros_organizacao (organizacao_id, user_id, papel) values ($1, $2, 'owner'), ($1, $3, 'admin')",
    [ORG, DONO, GESTOR],
  );
}

async function registrar(client, chave) {
  const { rows } = await client.query(
    `select evento_id from public.registrar_evento_outbox($1, null, null, $2, 'chatwoot', 'message.send', '{"conteudo": "c"}', 5)`,
    [ORG, chave],
  );
  return rows[0].evento_id;
}

async function executar(client, sql, params) {
  try {
    return { ok: true, linhas: (await client.query(sql, params)).rows };
  } catch (cause) {
    return { ok: false, code: cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : undefined };
  }
}

/** A abre transação e executa; B dispara sem esperar; o Postgres mostra B bloqueada; só então A commita. */
async function correr({ admin, clientA, clientB, sqlA, paramsA, sqlB, paramsB, timeoutDeObservacaoMs }) {
  await clientA.query('BEGIN');
  const a = await executar(clientA, sqlA, paramsA);
  if (!a.ok) {
    await clientA.query('ROLLBACK');
    return err('OutboxRaceInicioFalhou', 'A primeira chamada falhou antes da concorrência', { a });
  }
  const pidDeB = (await clientB.query('select pg_backend_pid() as pid')).rows[0].pid;
  const promiseB = executar(clientB, sqlB, paramsB);
  const observacao = await observarBloqueioNoPostgres(admin, pidDeB, { timeoutMs: timeoutDeObservacaoMs });
  if (!observacao.observado) {
    await clientA.query('ROLLBACK').catch(() => {});
    const bSeJaResolveu = await Promise.race([promiseB, esperar(50).then(() => undefined)]);
    return err('OutboxRaceNaoBloqueou', 'B nunca apareceu esperando um Lock', { bSeJaResolveu });
  }
  await clientA.query('COMMIT');
  return ok({ a: a.linhas, b: await promiseB, waitEvent: observacao.waitEvent });
}

/** Reivindica e despacha um evento pelo caminho real; devolve o token. */
async function despachar(client, eventoId, workerId) {
  const { rows } = await client.query('select fencing_token from public.reivindicar_evento_outbox($1, $2, $3, 60)', [ORG, eventoId, workerId]);
  const token = rows[0]?.fencing_token;
  const iniciou = (await client.query('select public.iniciar_despacho_outbox($1, $2, $3) as ok', [eventoId, workerId, token])).rows[0].ok;
  if (!iniciou) throw new Error('despacho de ensaio não iniciou');
  return token;
}

const SQL_CONCLUIR = "select public.concluir_tentativa_outbox($1, $2, $3, $4, $5) as status";
const SQL_REAPER = 'select evento_id, novo_status from public.liberar_leases_expirados_outbox()';
const SQL_REPLAY = 'select public.autorizar_replay_outbox($1, $2, $3) as status';

/**
 * O mesmo worker id perde a lease de um claim que nunca despachou, reivindica
 * de novo e despacha; a instância antiga, com o token velho, tenta devolver o
 * evento à fila como `nao_enviado`. Se conseguir, o despacho vigente some e o
 * próximo claim reenvia. Devolve o status gravado (`null` = recusado).
 */
async function tentarComTokenAntigo(client, eventoId) {
  const antigo = (await client.query(
    'select fencing_token from public.reivindicar_evento_outbox($1, $2, $3, 60)', [ORG, eventoId, 'w-mesmo-id'])).rows[0].fencing_token;
  await client.query("update public.outbox_eventos set lease_expires_at = now() - interval '1 second' where id = $1", [eventoId]);
  await client.query(SQL_REAPER);
  const vigente = await despachar(client, eventoId, 'w-mesmo-id');
  const { rows } = await client.query(SQL_CONCLUIR, [eventoId, 'w-mesmo-id', antigo, 'nao_enviado', null]);
  return { antigo, vigente, status: rows[0].status };
}

/** Remove a comparação do fencing token do corpo vigente da conclusão (sabotagem). */
async function sabotarFencing(client) {
  const { rows } = await client.query(
    "select pg_get_functiondef('public.concluir_tentativa_outbox(uuid,text,bigint,text,text,jsonb,text,text,text,integer)'::regprocedure) as def",
  );
  const sabotada = rows[0].def.replace('or v_evt.fencing_token is distinct from p_fencing_token', '');
  if (sabotada === rows[0].def) throw new Error('a comparação do token não foi encontrada para sabotar');
  await client.query(sabotada);
}

/**
 * @param {object} [options] - Fábrica de clientes e janela de observação injetáveis.
 * @returns {Promise<{ readonly _tag: 'ok', readonly value: Readonly<Record<string, unknown>> } | { readonly _tag: 'err', readonly error: Readonly<Record<string, unknown>> }>} Evidência ou falha tagueada.
 */
export async function runOutboxRaceRehearsal({
  createClient = () => createLocalDatabaseClient('orbita-database-concurrency-outbox'),
  timeoutDeObservacaoMs = 3000,
} = {}) {
  const admin = createClient();
  const clientA = createClient();
  const clientB = createClient();
  try {
    await admin.connect();
    await clientA.connect();
    await clientB.connect();
    await semear(admin);
    await clientA.query('set role service_role');
    await clientB.query('set role service_role');

    // 1. Lotes disjuntos.
    const lote = [];
    for (let i = 0; i < 6; i += 1) lote.push(await registrar(admin, `conc-lote-${i}`));
    await clientA.query('BEGIN');
    const doA = (await clientA.query("select evento_id, fencing_token from public.reivindicar_tentativas_outbox('wA', 3, 60)")).rows;
    const doB = (await clientB.query("select evento_id, fencing_token from public.reivindicar_tentativas_outbox('wB', 10, 60)")).rows;
    await clientA.query('COMMIT');
    const idsA = new Set(doA.map((r) => r.evento_id));
    const sobreposicao = doB.filter((r) => idsA.has(r.evento_id)).length;
    const cobertos = new Set([...idsA, ...doB.map((r) => r.evento_id)]);
    if (doA.length !== 3 || sobreposicao !== 0 || lote.some((id) => !cobertos.has(id))) {
      return err('OutboxRaceLoteSobreposto', 'Dois workers reivindicaram o mesmo evento', { a: doA.length, b: doB.length, sobreposicao });
    }

    // 2. Reaper × worker antigo com recibo tardio.
    const emVoo = await registrar(admin, 'conc-em-voo');
    const tokenEmVoo = await despachar(admin, emVoo, 'w-antigo');
    await admin.query("update public.outbox_eventos set lease_expires_at = now() - interval '1 second' where id = $1", [emVoo]);
    const reaper = await correr({
      admin, clientA, clientB, timeoutDeObservacaoMs,
      sqlA: SQL_REAPER, paramsA: [],
      sqlB: SQL_CONCLUIR, paramsB: [emVoo, 'w-antigo', tokenEmVoo, 'confirmado', 'recibo-tardio'],
    });
    if (reaper._tag === 'err') return reaper;
    const statusEmVoo = (await admin.query('select status, motivo_bloqueio from public.outbox_eventos where id = $1', [emVoo])).rows[0];
    if (!reaper.value.b.ok || reaper.value.b.linhas[0].status !== null || statusEmVoo.status !== 'unknown') {
      return err('OutboxRaceWorkerAntigoSobrescreveu', 'O worker antigo concluiu depois que o reaper decidiu', { b: reaper.value.b, statusEmVoo });
    }

    // 3. Replay autorizado duas vezes ao mesmo tempo.
    await admin.query(
      "select public.resolver_evento_desconhecido_outbox($1, $2, $3, 'provado_nao_aplicado', null, 'ensaio: provedor sem a mensagem')",
      [ORG, emVoo, DONO],
    );
    const replay = await correr({
      admin, clientA, clientB, timeoutDeObservacaoMs,
      sqlA: SQL_REPLAY, paramsA: [ORG, emVoo, DONO],
      sqlB: SQL_REPLAY, paramsB: [ORG, emVoo, GESTOR],
    });
    if (replay._tag === 'err') return replay;
    if (replay.value.b.ok || replay.value.b.code !== '55000') {
      return err('OutboxRaceReplayDuplo', 'Dois replays do mesmo efeito foram autorizados', { b: replay.value.b });
    }

    // 4. Contraprova: sem o fencing, o token antigo grava por cima.
    await admin.query('BEGIN');
    await sabotarFencing(admin);
    const sabotado = await tentarComTokenAntigo(admin, await registrar(admin, 'conc-sabotagem'));
    await admin.query('ROLLBACK');
    if (sabotado.status !== 'failed_transient') {
      return err('OutboxRaceContraprovaInerte', 'Sem o fencing o token antigo deveria concluir; o ensaio não detecta a remoção', { sabotado });
    }
    const protegido = await tentarComTokenAntigo(admin, await registrar(admin, 'conc-fencing'));
    if (protegido.status !== null || Number(protegido.vigente) <= Number(protegido.antigo)) {
      return err('OutboxRaceSemFencing', 'O token antigo do mesmo worker concluiu o efeito', { protegido });
    }

    return ok(Object.freeze({
      relato: `outbox com efeito ambíguo provada no Postgres: lotes disjuntos (${doA.length}+${doB.length}, sobreposição 0); `
        + `reaper → worker antigo com recibo tardio (wait_event=${reaper.value.waitEvent}) recusado pelo CAS, evento `
        + `${statusEmVoo.status}/${statusEmVoo.motivo_bloqueio}; replay duplo (wait_event=${replay.value.waitEvent}) recusado com `
        + `${replay.value.b.code}; contraprova: sem fencing o token ${sabotado.antigo} gravou ${sabotado.status}, com fencing `
        + `o token ${protegido.antigo} foi recusado (vigente ${protegido.vigente})`,
    }));
  } catch (cause) {
    await clientA.query('ROLLBACK').catch(() => {});
    await admin.query('ROLLBACK').catch(() => {});
    return err('OutboxRaceRehearsalFailed', 'Falha inesperada no rehearsal de concorrência da outbox', {}, cause);
  } finally {
    for (const client of [admin, clientA, clientB]) {
      try {
        await client.end();
      } catch {
        // Encerramento de conexão de teste; nada a fazer se já caiu.
      }
    }
  }
}
