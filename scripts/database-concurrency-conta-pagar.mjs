import { createLocalDatabaseClient } from './local-database-client.mjs';
import { err, ok } from './script-result.mjs';
import { esperar, observarBloqueioNoPostgres } from './database-concurrency.mjs';

/**
 * PRE-001, migration 73. Prova contra Postgres real, com duas conexões, que a
 * reivindicação da tentativa de conta a pagar decide sozinha quem pode chamar
 * o Bling — nunca dois.
 *
 * Duas corridas, com a mesma barreira determinística por `pg_stat_activity`
 * dos demais rehearsals (nada de esperar o relógio):
 *
 * 1. **Duplo clique** — a MESMA chave reivindicada ao mesmo tempo. A perdedora
 *    bloqueia no índice único, e quando a vencedora commita devolve `repetida`
 *    em `em_voo`: quem chamou não envia nada.
 * 2. **Recarregar a página** — chaves DIFERENTES para o MESMO lançamento. A
 *    perdedora bloqueia no índice parcial de pendência e devolve
 *    `pendencia_identica` apontando a chave vencedora.
 */

const ORG_ID = 'e0000000-0000-4000-8000-000000000001';
const DIGEST_DUPLO_CLIQUE = 'a'.repeat(64);
const DIGEST_RECARREGAR = 'b'.repeat(64);
const SQL_REIVINDICAR =
  'select * from public.reivindicar_tentativa_conta_pagar($1, $2, $3, 1200.00, \'2026-09-10\', \'2026-08-29\', null)';

async function seed(client) {
  await client.query(
    `insert into public.organizacoes (id, nome, slug) values ($1, 'Org Conta Pagar Concorrencia', 'org-conta-pagar-concorrencia')
     on conflict (id) do nothing`,
    [ORG_ID],
  );
}

async function reivindicar(client, chave, digest) {
  try {
    const linha = (await client.query(SQL_REIVINDICAR, [ORG_ID, chave, digest])).rows[0];
    return { ok: true, linha };
  } catch (cause) {
    return { ok: false, code: cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : undefined };
  }
}

/**
 * Uma corrida: A reivindica dentro de uma transação aberta, B dispara sem
 * esperar, o Postgres mostra B bloqueada, e só então A commita.
 */
async function correr({ admin, clientA, clientB, chaveA, chaveB, digest, timeoutDeObservacaoMs }) {
  await clientA.query('BEGIN');
  const a = await reivindicar(clientA, chaveA, digest);
  if (!a.ok || a.linha.desfecho !== 'nova') {
    await clientA.query('ROLLBACK');
    return err('ContaPagarRaceInicioInesperado', 'A primeira reivindicação deveria criar a tentativa', { a });
  }

  const pidDeB = (await clientB.query('select pg_backend_pid() as pid')).rows[0].pid;
  const promiseB = reivindicar(clientB, chaveB, digest);
  const observacao = await observarBloqueioNoPostgres(admin, pidDeB, { timeoutMs: timeoutDeObservacaoMs });
  if (!observacao.observado) {
    await clientA.query('ROLLBACK').catch(() => {});
    const bSeJaResolveu = await Promise.race([promiseB, esperar(50).then(() => undefined)]);
    return err('ContaPagarRaceNaoBloqueou', 'B nunca apareceu esperando um Lock enquanto A segurava a transação', { bSeJaResolveu });
  }

  await clientA.query('COMMIT');
  const b = await promiseB;
  if (!b.ok) {
    return err('ContaPagarRaceErroNaoTratado', 'A reivindicação perdedora lançou erro em vez de responder', { b });
  }

  const linhas = (await admin.query(
    'select count(*)::int as total from public.tentativas_conta_pagar where organizacao_id = $1 and digest = $2',
    [ORG_ID, digest],
  )).rows[0].total;

  return ok({ a: a.linha, b: b.linha, waitEvent: observacao.waitEvent, linhas });
}

/**
 * @param {object} [options] - Fábrica de clientes e janela de observação injetáveis.
 * @returns {Promise<{ readonly _tag: 'ok', readonly value: Readonly<Record<string, unknown>> } | { readonly _tag: 'err', readonly error: Readonly<Record<string, unknown>> }>} Evidência das duas corridas ou falha tagueada.
 */
export async function runContaPagarRaceRehearsal({
  createClient = () => createLocalDatabaseClient('orbita-database-concurrency-conta-pagar'),
  timeoutDeObservacaoMs = 3000,
} = {}) {
  const admin = createClient();
  const clientA = createClient();
  const clientB = createClient();
  try {
    await admin.connect();
    await seed(admin);
    await clientA.connect();
    await clientB.connect();

    const chave = 'e1000000-0000-4000-8000-000000000001';
    const duplo = await correr({
      admin, clientA, clientB, chaveA: chave, chaveB: chave, digest: DIGEST_DUPLO_CLIQUE, timeoutDeObservacaoMs,
    });
    if (duplo._tag === 'err') return duplo;
    const { a: a1, b: b1 } = duplo.value;
    if (b1.desfecho !== 'repetida' || b1.estado !== 'em_voo' || b1.tentativa_id !== a1.tentativa_id || duplo.value.linhas !== 1) {
      return err('ContaPagarDuploCliqueDoisVencedores', 'Duas reivindicações da MESMA chave não convergiram para uma tentativa em voo', duplo.value);
    }

    const recarregar = await correr({
      admin,
      clientA,
      clientB,
      chaveA: 'e1000000-0000-4000-8000-000000000002',
      chaveB: 'e1000000-0000-4000-8000-000000000003',
      digest: DIGEST_RECARREGAR,
      timeoutDeObservacaoMs,
    });
    if (recarregar._tag === 'err') return recarregar;
    const { b: b2 } = recarregar.value;
    if (b2.desfecho !== 'pendencia_identica' || b2.chave_pendente !== 'e1000000-0000-4000-8000-000000000002'
        || recarregar.value.linhas !== 1) {
      return err('ContaPagarRecarregarDoisVencedores', 'Duas chaves para o MESMO lançamento coexistiram pendentes', recarregar.value);
    }

    return ok(Object.freeze({
      relato: 'tentativa de conta a pagar provada com bloqueio observado no Postgres: duplo clique '
        + `(wait_event=${duplo.value.waitEvent}) deixou 1 tentativa e a perdedora viu ${b1.desfecho}/${b1.estado}; `
        + `recarregar com chave nova (wait_event=${recarregar.value.waitEvent}) deixou 1 tentativa e a perdedora `
        + `viu ${b2.desfecho} apontando a chave vencedora`,
    }));
  } catch (cause) {
    await clientA.query('ROLLBACK').catch(() => {});
    return err('ContaPagarRaceRehearsalFailed', 'Falha inesperada no rehearsal de concorrência da conta a pagar', {}, cause);
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
