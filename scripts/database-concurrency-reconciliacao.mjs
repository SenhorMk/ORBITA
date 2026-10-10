import { createLocalDatabaseClient } from './local-database-client.mjs';
import { err, ok } from './script-result.mjs';
import { esperar, observarBloqueioNoPostgres } from './database-concurrency.mjs';

/**
 * PRE-002, migration 74. Prova contra Postgres real, com duas conexões e a
 * barreira determinística por `pg_stat_activity`, que:
 *
 * 1. duas reconciliações simultâneas da MESMA operação, apontando contas
 *    remotas DIFERENTES, se serializam na trava da tentativa: só uma confirma,
 *    a outra grava `divergente`, e a conta remota gravada é uma só;
 * 2. duas reivindicações simultâneas da MESMA baixa produzem uma única
 *    intenção: a perdedora vê `repetida` e não envia nada;
 * 3. duas confirmações simultâneas de operações DIFERENTES apontando a MESMA
 *    conta remota se serializam na trava consultiva da conta: só uma confirma,
 *    a outra grava `divergente`/`conta_de_outra_operacao` — sem erro de
 *    unicidade escapando para o servidor.
 */

const ORG_ID = 'e7400000-0000-4000-8000-000000000001';
const ATOR = 'e7400000-0000-4000-8000-000000000002';
const CHAVE_CRIACAO = 'e7410000-0000-4000-8000-000000000001';
const CHAVE_BAIXA = 'e7410000-0000-4000-8000-000000000002';
const CHAVE_C = 'e7410000-0000-4000-8000-000000000003';
const CHAVE_D = 'e7410000-0000-4000-8000-000000000004';

async function seed(client) {
  await client.query(
    `insert into public.organizacoes (id, nome, slug) values ($1, 'Org Reconciliacao Concorrencia', 'org-reconciliacao-concorrencia')
     on conflict (id) do nothing`,
    [ORG_ID],
  );
  await client.query(
    `select * from public.reivindicar_tentativa_conta_pagar($1, $2, $3, 100.00, '2026-10-20', '2026-10-09', 7001, 'ORB-AAAAAAAAAAAAAAAA')`,
    [ORG_ID, CHAVE_CRIACAO, 'a'.repeat(64)],
  );
  await client.query(`update public.tentativas_conta_pagar set estado = 'indeterminada', motivo = 'sem_resposta' where chave = $1`, [CHAVE_CRIACAO]);
  await client.query(
    `select * from public.reivindicar_tentativa_conta_pagar($1, $2, $3, 50.00, '2026-10-20', '2026-10-09', 7001, 'ORB-BBBBBBBBBBBBBBBB')`,
    [ORG_ID, CHAVE_BAIXA, 'b'.repeat(64)],
  );
  await client.query(`update public.tentativas_conta_pagar set estado = 'confirmada', bling_conta_id = '880' where chave = $1`, [CHAVE_BAIXA]);
  for (const [chave, digito] of [[CHAVE_C, 'c'], [CHAVE_D, 'd']]) {
    await client.query(
      `select * from public.reivindicar_tentativa_conta_pagar($1, $2, $3, 70.00, '2026-10-20', '2026-10-09', 7001, $4)`,
      [ORG_ID, chave, digito.repeat(64), `ORB-${digito.toUpperCase().repeat(16)}`],
    );
    await client.query(`update public.tentativas_conta_pagar set estado = 'indeterminada', motivo = 'sem_resposta' where chave = $1`, [chave]);
  }
  return (await client.query('select id from public.tentativas_conta_pagar where chave = $1', [CHAVE_BAIXA])).rows[0].id;
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
    return err('ReconciliacaoRaceInicioFalhou', 'A primeira chamada falhou antes da concorrência', { a });
  }
  const pidDeB = (await clientB.query('select pg_backend_pid() as pid')).rows[0].pid;
  const promiseB = executar(clientB, sqlB, paramsB);
  const observacao = await observarBloqueioNoPostgres(admin, pidDeB, { timeoutMs: timeoutDeObservacaoMs });
  if (!observacao.observado) {
    await clientA.query('ROLLBACK').catch(() => {});
    const bSeJaResolveu = await Promise.race([promiseB, esperar(50).then(() => undefined)]);
    return err('ReconciliacaoRaceNaoBloqueou', 'B nunca apareceu esperando um Lock', { bSeJaResolveu });
  }
  await clientA.query('COMMIT');
  const b = await promiseB;
  if (!b.ok) return err('ReconciliacaoRaceErroNaoTratado', 'A chamada perdedora lançou em vez de responder', { a, b });
  return ok({ a: a.linha, b: b.linha, waitEvent: observacao.waitEvent });
}

const SQL_REGISTRAR = `select * from public.registrar_reconciliacao_conta_pagar(
  $1, $2, 'criacao', $3, $4, 'referencia_no_numero_documento', 'confirmada', null, $5, null, 1, 1)`;
const SQL_BAIXA = `select * from public.reivindicar_baixa_conta_pagar($1, $2, '880', '2026-10-09')`;

/**
 * @param {object} [options] - Fábrica de clientes e janela de observação injetáveis.
 * @returns {Promise<{ readonly _tag: 'ok', readonly value: Readonly<Record<string, unknown>> } | { readonly _tag: 'err', readonly error: Readonly<Record<string, unknown>> }>} Evidência ou falha tagueada.
 */
export async function runReconciliacaoRaceRehearsal({
  createClient = () => createLocalDatabaseClient('orbita-database-concurrency-reconciliacao'),
  timeoutDeObservacaoMs = 3000,
} = {}) {
  const admin = createClient();
  const clientA = createClient();
  const clientB = createClient();
  try {
    await admin.connect();
    await clientA.connect();
    await clientB.connect();
    const tentativaDaBaixa = await seed(admin);

    const reconciliacao = await correr({
      admin, clientA, clientB, timeoutDeObservacaoMs,
      sqlA: SQL_REGISTRAR, paramsA: [ORG_ID, CHAVE_CRIACAO, ATOR, 'corr-a', '881'],
      sqlB: SQL_REGISTRAR, paramsB: [ORG_ID, CHAVE_CRIACAO, ATOR, 'corr-b', '999'],
    });
    if (reconciliacao._tag === 'err') return reconciliacao;
    const gravada = (await admin.query('select bling_conta_id, estado from public.tentativas_conta_pagar where chave = $1', [CHAVE_CRIACAO])).rows[0];
    const recibos = (await admin.query(
      `select resultado from public.reconciliacoes_conta_pagar r join public.tentativas_conta_pagar t on t.id = r.tentativa_id
        where t.chave = $1 order by r.created_at`, [CHAVE_CRIACAO])).rows.map((r) => r.resultado);
    if (reconciliacao.value.a.resultado !== 'confirmada' || reconciliacao.value.b.resultado !== 'divergente'
        || gravada.bling_conta_id !== '881' || gravada.estado !== 'confirmada' || recibos.join(',') !== 'confirmada,divergente') {
      return err('ReconciliacaoRaceDoisVencedores', 'Reconciliações concorrentes não convergiram para uma conta remota só', {
        a: reconciliacao.value.a, b: reconciliacao.value.b, gravada, recibos,
      });
    }

    const baixa = await correr({
      admin, clientA, clientB, timeoutDeObservacaoMs,
      sqlA: SQL_BAIXA, paramsA: [ORG_ID, tentativaDaBaixa],
      sqlB: SQL_BAIXA, paramsB: [ORG_ID, tentativaDaBaixa],
    });
    if (baixa._tag === 'err') return baixa;
    const baixas = (await admin.query('select count(*)::int as total from public.baixas_conta_pagar where tentativa_id = $1', [tentativaDaBaixa])).rows[0].total;
    if (baixa.value.a.desfecho !== 'nova' || baixa.value.b.desfecho !== 'repetida'
        || baixa.value.b.baixa_id !== baixa.value.a.baixa_id || baixas !== 1) {
      return err('BaixaRaceDuasIntencoes', 'Duas reivindicações da mesma baixa não convergiram para uma intenção', {
        a: baixa.value.a, b: baixa.value.b, baixas,
      });
    }

    const mesmaConta = await correr({
      admin, clientA, clientB, timeoutDeObservacaoMs,
      sqlA: SQL_REGISTRAR, paramsA: [ORG_ID, CHAVE_C, ATOR, 'corr-c', '777'],
      sqlB: SQL_REGISTRAR, paramsB: [ORG_ID, CHAVE_D, ATOR, 'corr-d', '777'],
    });
    if (mesmaConta._tag === 'err') return mesmaConta;
    const donos = (await admin.query(
      `select chave::text, estado from public.tentativas_conta_pagar where organizacao_id = $1 and bling_conta_id = '777'`, [ORG_ID])).rows;
    if (mesmaConta.value.a.resultado !== 'confirmada' || mesmaConta.value.b.resultado !== 'divergente'
        || mesmaConta.value.b.motivo !== 'conta_de_outra_operacao' || donos.length !== 1 || donos[0].chave !== CHAVE_C) {
      return err('ReconciliacaoRaceContaCompartilhada', 'Duas operações confirmaram a mesma conta remota', {
        a: mesmaConta.value.a, b: mesmaConta.value.b, donos,
      });
    }

    return ok(Object.freeze({
      relato: 'reconciliação provada com bloqueio observado no Postgres: duas conferências concorrentes '
        + `(wait_event=${reconciliacao.value.waitEvent}) gravaram confirmada e divergente, conta remota única ${gravada.bling_conta_id}; `
        + `duas reivindicações da mesma baixa (wait_event=${baixa.value.waitEvent}) deixaram ${baixas} intenção, a perdedora viu repetida; `
        + `duas operações na mesma conta remota (wait_event=${mesmaConta.value.waitEvent}) deixaram ${donos.length} dona, a outra divergente/conta_de_outra_operacao`,
    }));
  } catch (cause) {
    await clientA.query('ROLLBACK').catch(() => {});
    return err('ReconciliacaoRaceRehearsalFailed', 'Falha inesperada no rehearsal de concorrência da reconciliação', {}, cause);
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
