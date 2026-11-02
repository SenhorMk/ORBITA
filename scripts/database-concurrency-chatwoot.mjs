import { err, ok } from './script-result.mjs';
import { esperar, observarBloqueioNoPostgres } from './database-concurrency.mjs';

/**
 * Peças comuns dos ensaios de concorrência dos espelhos do Chatwoot
 * (identidade, resolver). `rotulo` prefixa as tags de falha de cada ensaio.
 */

export async function executar(client, sql, params) {
  try {
    return { ok: true, linhas: (await client.query(sql, params)).rows };
  } catch (cause) {
    return { ok: false, code: cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : undefined };
  }
}

/** A abre transação e executa; B dispara sem esperar; o Postgres mostra B bloqueada; só então A commita. */
export async function correr({ admin, clientA, clientB, sqlA, paramsA, sqlB, paramsB, timeoutDeObservacaoMs, rotulo }) {
  await clientA.query('BEGIN');
  const a = await executar(clientA, sqlA, paramsA);
  if (!a.ok) {
    await clientA.query('ROLLBACK');
    return err(`${rotulo}InicioFalhou`, 'A primeira escrita falhou antes da concorrência', { a });
  }
  const pidDeB = (await clientB.query('select pg_backend_pid() as pid')).rows[0].pid;
  const promiseB = executar(clientB, sqlB, paramsB);
  const observacao = await observarBloqueioNoPostgres(admin, pidDeB, { timeoutMs: timeoutDeObservacaoMs });
  if (!observacao.observado) {
    await clientA.query('ROLLBACK').catch(() => {});
    const bSeJaResolveu = await Promise.race([promiseB, esperar(50).then(() => undefined)]);
    return err(`${rotulo}NaoBloqueou`, 'B nunca apareceu esperando um Lock', { bSeJaResolveu });
  }
  await clientA.query('COMMIT');
  return ok({ a: a.linhas, b: await promiseB, waitEvent: observacao.waitEvent });
}

/** A segura a transação; B tem de concluir antes de A commitar (sem chave comum entre eles). */
export async function semEsperar({ clientA, clientB, sqlA, paramsA, sqlB, paramsB, timeoutDeObservacaoMs, rotulo }) {
  await clientA.query('BEGIN');
  const a = await executar(clientA, sqlA, paramsA);
  if (!a.ok) {
    await clientA.query('ROLLBACK');
    return err(`${rotulo}InicioFalhou`, 'A primeira escrita falhou antes da concorrência', { a });
  }
  const b = await Promise.race([executar(clientB, sqlB, paramsB), esperar(timeoutDeObservacaoMs).then(() => undefined)]);
  if (b === undefined) {
    await clientA.query('ROLLBACK').catch(() => {});
    return err(`${rotulo}Bloqueou`, 'B esperou A: ainda há chave global entre instalações', {});
  }
  await clientA.query('COMMIT');
  return ok({ a: a.linhas, b });
}

/**
 * Contato legado (sem conexão, anterior ao MSG-004) e, se `conversa`, a sua
 * conversa legada no `inbox`, ligada pelo UUID local. Fabricado com o gatilho
 * de identidade desligado: depois do MSG-004 nenhuma escrita cria linha sem
 * conexão. Devolve o UUID do contato.
 */
export async function fabricarLegado(client, { organizacao, contato, conversa, inbox, nome = 'legado' }) {
  await client.query('BEGIN');
  try {
    await client.query('alter table public.chatwoot_contacts disable trigger trg_vincula_identidade_local_chatwoot');
    await client.query('alter table public.chatwoot_conversations disable trigger trg_vincula_identidade_local_chatwoot');
    const { rows } = await client.query(
      'insert into public.chatwoot_contacts (id, id_externo, organizacao_id, name) values ($1::int, $1::int::text, $2, $3) returning id_local',
      [contato, organizacao, nome]);
    if (conversa !== undefined) {
      await client.query(
        `insert into public.chatwoot_conversations (id, id_externo, organizacao_id, contact_id, contato_id_local, status, inbox_id)
         values ($1::int, $1::int::text, $2, $3, $4, 'open', $5)`,
        [conversa, organizacao, contato, rows[0].id_local, inbox]);
    }
    await client.query('alter table public.chatwoot_contacts enable trigger trg_vincula_identidade_local_chatwoot');
    await client.query('alter table public.chatwoot_conversations enable trigger trg_vincula_identidade_local_chatwoot');
    await client.query('COMMIT');
    return rows[0].id_local;
  } catch (cause) {
    await client.query('ROLLBACK');
    throw cause;
  }
}
