import { createHash } from 'node:crypto';

import { createLocalDatabaseClient } from './local-database-client.mjs';
import { err, ok } from './script-result.mjs';
import { esperar, observarBloqueioNoPostgres } from './database-concurrency.mjs';
import { aplicarPendentes } from './migracoes-remotas.mjs';

/**
 * Dois executores de `scripts/migracoes-remotas.mjs` aplicando a MESMA
 * migration ao mesmo tempo, contra Postgres real e duas conexões.
 *
 * A migration sintética incrementa uma **sequência** — efeito que o rollback
 * não desfaz — e dorme, abrindo a janela. Se o SQL rodasse duas vezes, o
 * contador mostraria 2 mesmo que a segunda transação terminasse revertida
 * pela chave primária do registro: a prova não depende de quem "ganhou".
 *
 * Invariante: o segundo executor espera a trava de transação do primeiro
 * (`wait_event` advisory), relê o registro depois de entrar, e para com
 * `MigracaoJaRegistrada` sem executar o SQL. Contador 1, registro 1.
 */

const PATH = '../database/zz_ensaio_concorrencia_da_ferramenta.sql';
const SQL = "select nextval('public.ensaio_execucoes_da_migration'); select pg_sleep(1.2);";
const MIGRACAO = Object.freeze({ order: 9001, path: PATH, sha256: createHash('sha256').update(SQL).digest('hex') });
const DISCO = { readFileSync: () => SQL };

/** O executor está DENTRO do SQL da migration (no `pg_sleep`), com ou sem trava. */
async function dentroDaMigracao(admin, pid) {
  const { rows } = await admin.query(
    "select 1 from pg_stat_activity where pid = $1 and wait_event = 'PgSleep'", [pid]);
  return rows.length > 0;
}

/**
 * @param {object} [options] - Fábrica de clientes e janela de observação injetáveis.
 * @returns {Promise<{ readonly _tag: 'ok', readonly value: { readonly relato: string } } | { readonly _tag: 'err', readonly error: Readonly<Record<string, unknown>> }>}
 */
export async function runMigracoesRemotasRaceRehearsal({
  createClient = () => createLocalDatabaseClient('orbita-database-concurrency-migracoes'),
  timeoutDeObservacaoMs = 3000,
} = {}) {
  const admin = createClient();
  const executorA = createClient();
  const executorB = createClient();
  try {
    await admin.connect();
    await executorA.connect();
    await executorB.connect();
    // Tabela de registro e contador criados antes, para isolar a propriedade:
    // a corrida é só sobre executar a mesma migration.
    await admin.query(`create table if not exists public.migracoes_aplicadas (
      ordem integer not null, arquivo text primary key, sha256 text not null, aplicada_em timestamptz not null default now())`);
    await admin.query('create sequence if not exists public.ensaio_execucoes_da_migration');

    const pidA = (await executorA.query('select pg_backend_pid() as pid')).rows[0].pid;
    const pidB = (await executorB.query('select pg_backend_pid() as pid')).rows[0].pid;

    const promessaA = aplicarPendentes({ client: executorA, pendentes: [MIGRACAO], fileSystem: DISCO, log: () => {} });
    // B só parte quando A está comprovadamente no meio do SQL da migration —
    // a janela exata em que dois executores sem exclusão mútua rodariam juntos.
    const limite = Date.now() + timeoutDeObservacaoMs;
    while (!(await dentroDaMigracao(admin, pidA)) && Date.now() < limite) await esperar(10);
    if (!(await dentroDaMigracao(admin, pidA))) {
      await promessaA;
      return err('MigracoesRemotasRaceNaoEncenada', 'o executor A não foi visto dentro da migration');
    }

    const promessaB = aplicarPendentes({ client: executorB, pendentes: [MIGRACAO], fileSystem: DISCO, log: () => {} });
    const observacao = await observarBloqueioNoPostgres(admin, pidB, { timeoutMs: timeoutDeObservacaoMs });
    const [a, b] = await Promise.all([promessaA, promessaB]);

    const execucoes = Number((await admin.query(
      'select case when is_called then last_value else 0 end as n from public.ensaio_execucoes_da_migration')).rows[0].n);
    const registros = Number((await admin.query(
      'select count(*)::int as n from public.migracoes_aplicadas where arquivo = $1', [PATH])).rows[0].n);

    await admin.query('delete from public.migracoes_aplicadas where arquivo = $1', [PATH]);
    await admin.query('drop sequence if exists public.ensaio_execucoes_da_migration');

    const problemas = [];
    if (execucoes !== 1) problemas.push(`o SQL da migration executou ${execucoes} vez(es)`);
    if (registros !== 1) problemas.push(`registros=${registros}`);
    if (!observacao.observado) problemas.push('o segundo executor não esperou a trava');
    if (a._tag !== 'ok') problemas.push(`executor A: ${a.error?._tag}`);
    if (b._tag !== 'err' || b.error._tag !== 'MigracaoJaRegistrada') problemas.push(`executor B: ${b._tag === 'err' ? b.error._tag : 'aplicou'}`);
    if (problemas.length > 0) {
      return err('MigracoesRemotasRaceViolated', `dois executores da mesma migration: ${problemas.join(' | ')}`, { problemas });
    }

    return ok(Object.freeze({
      relato: 'ferramenta de migrations remotas provada com dois executores simultâneos da mesma migration: '
        + `o segundo esperou a trava de transação (wait_event=${observacao.waitEvent}), releu o registro e parou com `
        + `${b.error._tag}; o SQL executou ${execucoes} vez e há ${registros} registro`,
    }));
  } catch (cause) {
    return err('MigracoesRemotasRaceFailed', 'não foi possível encenar a corrida dos executores', {}, cause);
  } finally {
    await executorA.end().catch(() => {});
    await executorB.end().catch(() => {});
    await admin.end().catch(() => {});
  }
}
