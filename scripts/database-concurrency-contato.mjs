import { createLocalDatabaseClient } from './local-database-client.mjs';
import { err, ok } from './script-result.mjs';
import { esperar, observarBloqueioNoPostgres } from './database-concurrency.mjs';

/**
 * PRE-005, migration 77. Prova contra Postgres real, com duas conexões e a
 * barreira determinística por `pg_stat_activity`, que a exclusão de contato no
 * Bling, a reativação e a gravação do contato se serializam na mesma trava
 * consultiva de (organização, `bling_id`):
 *
 * 1. a exclusão segura a trava; o upsert do webhook (update atrasado com
 *    `Cliente #id`) espera e, depois do commit, é recusado com 23514 — o
 *    contato fica com o nome real, marcado como excluído, e o pedido continua
 *    apontando para ele;
 * 2. a gravação de um contato novo segura a trava; a exclusão espera e, depois
 *    do commit, encontra o contato e o marca (`registrado`);
 * 3. duas exclusões simultâneas do mesmo id deixam uma exclusão vigente só:
 *    `registrado` e `ja_registrado`;
 * 4. a reativação segura a trava; uma exclusão com data posterior espera e,
 *    depois do commit, registra outra vigente — o histórico fica com as duas;
 * 5. a reativação segura a trava; a exclusão antiga, reentregue com outra
 *    chave, espera e, depois do commit, vê a reativação e não a desfaz
 *    (`anterior_a_reativacao`);
 * 6. a reconciliação que resolve uma pendência (contato ativo) segura a trava;
 *    a reentrega da mesma entrega que a abriu espera e, depois do commit,
 *    responde `ja_resolvido` — a pendência não reabre;
 * 7. a confirmação de uma pendência segura a trava; outra entrega sem ordem
 *    provável espera e, depois do commit, vê a exclusão confirmada
 *    (`ja_registrado`) — sem segunda linha aberta.
 */

const ORG_ID = 'e7700000-0000-4000-8000-000000000001';
const OWNER_ID = 'e7700000-0000-4000-8000-000000000002';
const CLIENTE_ID = 'e7700000-0000-4000-8000-000000000003';
const PEDIDO_ID = 'e7700000-0000-4000-8000-000000000004';

async function semear(client) {
  await client.query("insert into auth.users (id, email) values ($1, 'owner-contato@orbita.test')", [OWNER_ID]);
  await client.query(
    "insert into public.organizacoes (id, nome, slug, status) values ($1, 'Org Contato', 'org-contato', 'active')",
    [ORG_ID],
  );
  await client.query("insert into public.membros_organizacao (organizacao_id, user_id, papel) values ($1, $2, 'owner')", [ORG_ID, OWNER_ID]);
  await client.query(
    "insert into public.clientes (id, organizacao_id, user_id, bling_id, nome) values ($1, $2, $3, '77001', 'Maria Real')",
    [CLIENTE_ID, ORG_ID, OWNER_ID],
  );
  await client.query(
    `insert into public.pedidos (id, organizacao_id, user_id, bling_id, numero, data, cliente_id, total)
     values ($1, $2, $3, '77010', '77010', now(), $4, 20)`,
    [PEDIDO_ID, ORG_ID, OWNER_ID, CLIENTE_ID],
  );
}

async function executar(client, sql, params) {
  try {
    return { ok: true, linha: (await client.query(sql, params)).rows[0] };
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
    return err('ContatoRaceInicioFalhou', 'A primeira chamada falhou antes da concorrência', { a });
  }
  const pidDeB = (await clientB.query('select pg_backend_pid() as pid')).rows[0].pid;
  const promiseB = executar(clientB, sqlB, paramsB);
  const observacao = await observarBloqueioNoPostgres(admin, pidDeB, { timeoutMs: timeoutDeObservacaoMs });
  if (!observacao.observado) {
    await clientA.query('ROLLBACK').catch(() => {});
    const bSeJaResolveu = await Promise.race([promiseB, esperar(50).then(() => undefined)]);
    return err('ContatoRaceNaoBloqueou', 'B nunca apareceu esperando um Lock', { bSeJaResolveu });
  }
  await clientA.query('COMMIT');
  return ok({ a: a.linha, b: await promiseB, waitEvent: observacao.waitEvent });
}

const SQL_EXCLUIR = 'select * from public.registrar_exclusao_de_contato_no_bling($1, $2, null)';
/** Exclusão com a data do evento no Bling, relativa ao relógio do banco. */
const SQL_EXCLUIR_EM = 'select * from public.registrar_exclusao_de_contato_no_bling($1, $2, now() + $3::interval)';
/** Exclusão sem data, como uma entrega que não prova a ordem, com a chave da entrega. */
const SQL_EXCLUIR_SEM_DATA = 'select * from public.registrar_exclusao_de_contato_no_bling($1, $2, null, $3)';
const SQL_CONFIRMAR = 'select * from public.confirmar_exclusao_pendente_de_contato($1, $2, $3)';
const SQL_REATIVAR = 'select * from public.reativar_contato_excluido_no_bling($1, $2, $3)';
/** O upsert do webhook (`clienteRepository.upsert`), como o update atrasado sem nome o fazia. */
const SQL_UPSERT = `insert into public.clientes (organizacao_id, user_id, bling_id, nome)
  values ($1, $2, $3, 'Cliente #' || $3)
  on conflict (organizacao_id, bling_id) do update set nome = excluded.nome
  returning id`;

/**
 * @param {object} [options] - Fábrica de clientes e janela de observação injetáveis.
 * @returns {Promise<{ readonly _tag: 'ok', readonly value: Readonly<Record<string, unknown>> } | { readonly _tag: 'err', readonly error: Readonly<Record<string, unknown>> }>} Evidência ou falha tagueada.
 */
export async function runContatoExcluidoRaceRehearsal({
  createClient = () => createLocalDatabaseClient('orbita-database-concurrency-contato'),
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

    const exclusaoPrimeiro = await correr({
      admin, clientA, clientB, timeoutDeObservacaoMs,
      sqlA: SQL_EXCLUIR, paramsA: [ORG_ID, '77001'],
      sqlB: SQL_UPSERT, paramsB: [ORG_ID, OWNER_ID, '77001'],
    });
    if (exclusaoPrimeiro._tag === 'err') return exclusaoPrimeiro;
    const maria = (await admin.query('select nome, excluido_no_bling_em from public.clientes where id = $1', [CLIENTE_ID])).rows[0];
    const pedido = (await admin.query(
      'select c.nome from public.pedidos p join public.clientes c on c.id = p.cliente_id where p.id = $1', [PEDIDO_ID])).rows[0];
    if (exclusaoPrimeiro.value.a.desfecho !== 'registrado' || exclusaoPrimeiro.value.b.ok || exclusaoPrimeiro.value.b.code !== '23514'
        || maria.nome !== 'Maria Real' || maria.excluido_no_bling_em === null || pedido?.nome !== 'Maria Real') {
      return err('ContatoRaceRessuscitou', 'O update atrasado concorrente regravou o contato excluído', { b: exclusaoPrimeiro.value.b, contato: maria, pedido });
    }

    const gravacaoPrimeiro = await correr({
      admin, clientA, clientB, timeoutDeObservacaoMs,
      sqlA: SQL_UPSERT, paramsA: [ORG_ID, OWNER_ID, '77002'],
      sqlB: SQL_EXCLUIR, paramsB: [ORG_ID, '77002'],
    });
    if (gravacaoPrimeiro._tag === 'err') return gravacaoPrimeiro;
    const novo = (await admin.query("select excluido_no_bling_em from public.clientes where organizacao_id = $1 and bling_id = '77002'", [ORG_ID])).rows[0];
    if (!gravacaoPrimeiro.value.b.ok || gravacaoPrimeiro.value.b.linha.desfecho !== 'registrado' || !novo?.excluido_no_bling_em) {
      return err('ContatoRacePerdeuContato', 'A exclusão que esperou a gravação não marcou o contato', { b: gravacaoPrimeiro.value.b, contato: novo });
    }

    const duas = await correr({
      admin, clientA, clientB, timeoutDeObservacaoMs,
      sqlA: SQL_EXCLUIR, paramsA: [ORG_ID, '77003'],
      sqlB: SQL_EXCLUIR, paramsB: [ORG_ID, '77003'],
    });
    if (duas._tag === 'err') return duas;
    const vigentes = (await admin.query(
      "select count(*)::int as n from public.contatos_excluidos_no_bling where organizacao_id = $1 and bling_id = '77003' and reativado_em is null", [ORG_ID])).rows[0].n;
    if (duas.value.a.desfecho !== 'registrado_sem_contato' || duas.value.b.linha?.desfecho !== 'ja_registrado' || vigentes !== 1) {
      return err('ContatoRaceDuplicou', 'Duas exclusões concorrentes não convergiram para uma vigente', { b: duas.value.b, vigentes });
    }

    const reativacao = await correr({
      admin, clientA, clientB, timeoutDeObservacaoMs,
      sqlA: SQL_REATIVAR, paramsA: [ORG_ID, '77001', OWNER_ID],
      sqlB: SQL_EXCLUIR_EM, paramsB: [ORG_ID, '77001', '10 minutes'],
    });
    if (reativacao._tag === 'err') return reativacao;
    const historico = (await admin.query(
      `select count(*)::int as total, count(*) filter (where reativado_em is null)::int as vigentes
         from public.contatos_excluidos_no_bling where organizacao_id = $1 and bling_id = '77001'`, [ORG_ID])).rows[0];
    if (reativacao.value.a.desfecho !== 'reativado' || reativacao.value.b.linha?.desfecho !== 'registrado'
        || historico.total !== 2 || historico.vigentes !== 1) {
      return err('ContatoRaceReativacao', 'Reativação e nova exclusão concorrentes não se serializaram', { b: reativacao.value.b, historico });
    }

    // O 77002 foi excluído na corrida 2; ele é reativado enquanto a exclusão antiga chega.
    const antiga = await correr({
      admin, clientA, clientB, timeoutDeObservacaoMs,
      sqlA: SQL_REATIVAR, paramsA: [ORG_ID, '77002', OWNER_ID],
      sqlB: SQL_EXCLUIR_EM, paramsB: [ORG_ID, '77002', '-1 day'],
    });
    if (antiga._tag === 'err') return antiga;
    const reativado = (await admin.query("select excluido_no_bling_em from public.clientes where organizacao_id = $1 and bling_id = '77002'", [ORG_ID])).rows[0];
    if (antiga.value.a.desfecho !== 'reativado' || antiga.value.b.linha?.desfecho !== 'anterior_a_reativacao' || reativado.excluido_no_bling_em !== null) {
      return err('ContatoRaceExclusaoAntiga', 'A exclusão antiga concorrente desfez a reativação', { b: antiga.value.b, contato: reativado });
    }

    // 77002 está reativado (corrida 5): uma entrega sem data abre a pendência.
    const aberta = (await admin.query(SQL_EXCLUIR_SEM_DATA, [ORG_ID, '77002', 'k-pendencia'])).rows[0];
    const resolve = await correr({
      admin, clientA, clientB, timeoutDeObservacaoMs,
      sqlA: SQL_REATIVAR, paramsA: [ORG_ID, '77002', OWNER_ID],
      sqlB: SQL_EXCLUIR_SEM_DATA, paramsB: [ORG_ID, '77002', 'k-pendencia'],
    });
    if (resolve._tag === 'err') return resolve;
    const liberado = (await admin.query(
      "select excluido_no_bling_em, exclusao_pendente_desde from public.clientes where organizacao_id = $1 and bling_id = '77002'", [ORG_ID])).rows[0];
    if (aberta.desfecho !== 'reconciliacao_necessaria' || resolve.value.a.desfecho !== 'reativado'
        || resolve.value.b.linha?.desfecho !== 'ja_resolvido' || liberado.excluido_no_bling_em !== null || liberado.exclusao_pendente_desde !== null) {
      return err('ContatoRacePendenciaReaberta', 'A reentrega concorrente reabriu a pendência resolvida', { aberta, b: resolve.value.b, contato: liberado });
    }

    const segunda = (await admin.query(SQL_EXCLUIR_SEM_DATA, [ORG_ID, '77002', 'k-pendencia-2'])).rows[0];
    const confirma = await correr({
      admin, clientA, clientB, timeoutDeObservacaoMs,
      sqlA: SQL_CONFIRMAR, paramsA: [ORG_ID, '77002', OWNER_ID],
      sqlB: SQL_EXCLUIR_SEM_DATA, paramsB: [ORG_ID, '77002', 'k-pendencia-3'],
    });
    if (confirma._tag === 'err') return confirma;
    const confirmado = (await admin.query(
      `select (select count(*)::int from public.contatos_excluidos_no_bling where organizacao_id = $1 and bling_id = '77002' and reativado_em is null) as abertas,
              (select excluido_no_bling_em is not null from public.clientes where organizacao_id = $1 and bling_id = '77002') as excluido`, [ORG_ID])).rows[0];
    if (segunda.desfecho !== 'reconciliacao_necessaria' || confirma.value.a.desfecho !== 'confirmada'
        || confirma.value.b.linha?.desfecho !== 'ja_registrado' || confirmado.abertas !== 1 || !confirmado.excluido) {
      return err('ContatoRaceConfirmacao', 'Confirmação e nova entrega concorrentes não convergiram', { segunda, b: confirma.value.b, estado: confirmado });
    }

    return ok(Object.freeze({
      relato: `exclusão de contato provada com bloqueio observado no Postgres: exclusão → upsert atrasado com Cliente #id `
        + `(wait_event=${exclusaoPrimeiro.value.waitEvent}) recusado com ${exclusaoPrimeiro.value.b.code}, contato com o nome real e o pedido `
        + `legível; gravação → exclusão (wait_event=${gravacaoPrimeiro.value.waitEvent}) marcou o contato recém-gravado; duas exclusões `
        + `simultâneas (wait_event=${duas.value.waitEvent}) deram ${duas.value.a.desfecho} e ${duas.value.b.linha.desfecho} com ${vigentes} vigente; `
        + `reativação → nova exclusão (wait_event=${reativacao.value.waitEvent}) deixou ${historico.total} registros e ${historico.vigentes} vigente; `
        + `reativação → exclusão antiga reentregue (wait_event=${antiga.value.waitEvent}) deu ${antiga.value.b.linha.desfecho} e o contato seguiu reativado; `
        + `resolução da pendência → reentrega da mesma entrega (wait_event=${resolve.value.waitEvent}) deu ${resolve.value.b.linha.desfecho}; `
        + `confirmação da pendência → nova entrega sem ordem (wait_event=${confirma.value.waitEvent}) deu ${confirma.value.b.linha.desfecho} com ${confirmado.abertas} aberta`,
    }));
  } catch (cause) {
    await clientA.query('ROLLBACK').catch(() => {});
    return err('ContatoRaceRehearsalFailed', 'Falha inesperada no rehearsal de concorrência da exclusão de contato', {}, cause);
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
