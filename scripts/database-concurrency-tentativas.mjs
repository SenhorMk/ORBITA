import { createLocalDatabaseClient } from './local-database-client.mjs';
import { err, ok } from './script-result.mjs';
import { esperar, observarBloqueioNoPostgres } from './database-concurrency.mjs';

/**
 * Ticket 30, fatia 3 — 4ª rodada de revisão. Prova de atomicidade da
 * reivindicação de tentativa (`reivindicar_tentativa_venda_manual`,
 * migration 59), a peça que decide se uma retentativa pode chamar o Bling
 * de novo.
 *
 * **Achado real desta rodada**: a primeira versão da RPC fazia
 * `SELECT ... FOR UPDATE` e só DEPOIS `INSERT` se não achasse nada — e
 * reproduzia, dentro do próprio mecanismo criado para fechar a corrida do
 * ticket 30, a MESMA corrida. `SELECT ... FOR UPDATE` sobre uma linha que
 * ainda não existe não bloqueia nada. Reproduzido contra Postgres real com
 * duas conexões: uma reivindicação vencia, a outra lançava `23505` NÃO
 * TRATADO em vez de devolver `TentativaEmAndamento` graciosamente.
 *
 * A correção usa o mesmo mecanismo já provado em
 * `database-concurrency.mjs`/`evidence/30-atomicidade-da-tomada-2026-09-03.md`:
 * `INSERT ... ON CONFLICT DO NOTHING RETURNING` primeiro; só se não inserir
 * (conflito) é que o `SELECT ... FOR UPDATE` roda — e nesse ponto a linha
 * EXISTE, então o bloqueio é real.
 *
 * Este módulo prova a correção com a MESMA barreira determinística por
 * `pg_stat_activity` — não passagem de tempo.
 */

const ORG_ID = 'd0000000-0000-4000-8000-000000000001';
const OWNER_ID = 'd0000000-0000-4000-8000-000000000002';
const REFERENCIA = 'referencia-concorrente-d0';

async function seed(client) {
  await client.query(`
    insert into auth.users (id, email) values ($1, 'owner-tentativa-concorrencia@orbita.test')
    on conflict (id) do nothing
  `, [OWNER_ID]);
  await client.query(`
    insert into public.organizacoes (id, nome, slug) values ($1, 'Org Tentativa Concorrencia', 'org-tentativa-concorrencia')
    on conflict (id) do nothing
  `, [ORG_ID]);
  await client.query(`
    insert into public.membros_organizacao (organizacao_id, user_id, papel) values ($1, $2, 'owner')
    on conflict (organizacao_id, user_id) do nothing
  `, [ORG_ID, OWNER_ID]);
}

const SQL_REIVINDICAR = `select * from public.reivindicar_tentativa_venda_manual($1, $2)`;

async function tentarReivindicar(client) {
  try {
    const resultado = await client.query(SQL_REIVINDICAR, [ORG_ID, REFERENCIA]);
    const linha = resultado.rows[0];
    return { ok: true, tentativaId: linha.tentativa_id, isDuplicate: linha.is_duplicate, estado: linha.estado };
  } catch (cause) {
    return { ok: false, code: cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : undefined, message: cause?.message };
  }
}

/**
 * Prova, com barreira determinística por `pg_stat_activity`, que duas
 * reivindicações concorrentes da MESMA `referenciaLocal` nunca lançam um
 * erro não tratado e nunca produzem duas "vencedoras" — exatamente a
 * garantia que faz o endpoint HTTP nunca chamar `createPedidoVenda` duas
 * vezes para a mesma tentativa lógica.
 *
 * @param {object} [options] - Fábrica de clientes e janela de observação injetáveis para teste.
 * @returns {Promise<{ readonly _tag: 'ok', readonly value: Readonly<Record<string, unknown>> } | { readonly _tag: 'err', readonly error: Readonly<Record<string, unknown>> }>} Evidência da corrida ou falha tagueada.
 */
export async function runTentativaClaimRaceRehearsal({
  createClient = () => createLocalDatabaseClient('orbita-database-concurrency-tentativas'),
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

    // Passo 1: A abre transação explícita e reivindica — o INSERT toma o
    // bloqueio do índice único, mas nada é commitado ainda.
    await clientA.query('BEGIN');
    const resultadoA = await tentarReivindicar(clientA);
    if (!resultadoA.ok) {
      await clientA.query('ROLLBACK');
      return err('TentativaRaceReivindicacaoInicialFalhou', 'A primeira reivindicação (dentro da transação aberta) deveria ter sucedido; falhou antes de haver concorrência', { resultadoA });
    }
    if (resultadoA.isDuplicate) {
      await clientA.query('ROLLBACK');
      return err('TentativaRaceEstadoInicialInesperado', 'A primeira reivindicação, contra uma referência nova, não deveria ser duplicata', { resultadoA });
    }

    // Passo 2: B dispara a MESMA reivindicação, sem esperar A.
    const pidDeB = (await clientB.query('select pg_backend_pid() as pid')).rows[0].pid;
    const promiseB = tentarReivindicar(clientB);

    // Passo 3: observa NO POSTGRES que B está genuinamente bloqueada.
    const observacao = await observarBloqueioNoPostgres(admin, pidDeB, { timeoutMs: timeoutDeObservacaoMs });
    if (!observacao.observado) {
      await clientA.query('ROLLBACK').catch(() => {});
      const resultadoBSeJaResolveu = await Promise.race([promiseB, esperar(50).then(() => undefined)]);
      return err(
        'TentativaRaceNaoBloqueou',
        'pg_stat_activity nunca marcou a conexão B como esperando um Lock enquanto A segurava a transação aberta',
        { pidDeB, timeoutDeObservacaoMs, resultadoBSeJaResolveu },
      );
    }

    // Passo 4: só agora A commita.
    await clientA.query('COMMIT');

    // Passo 5: B destrava — o ponto central deste rehearsal é que ela NUNCA
    // lança um erro não tratado (o defeito real encontrado nesta rodada) e
    // devolve `is_duplicate: true` graciosamente.
    const resultadoB = await promiseB;

    if (!resultadoB.ok) {
      return err(
        'TentativaRaceLancouErroNaoTratado',
        'A reivindicação perdedora lançou um erro em vez de devolver TentativaEmAndamento graciosamente — o mesmo defeito de origem do ticket 30, reproduzido dentro do próprio mecanismo que deveria fechá-lo',
        { resultadoA, resultadoB },
      );
    }
    if (!resultadoB.isDuplicate) {
      return err('TentativaRaceDoubleWinner', 'A reivindicação perdedora deveria ver is_duplicate=true; também venceu', { resultadoA, resultadoB });
    }
    if (resultadoB.tentativaId !== resultadoA.tentativaId) {
      return err('TentativaRaceIdsDivergentes', 'As duas reivindicações deveriam apontar para a MESMA tentativa_id', { resultadoA, resultadoB });
    }

    const contagem = await admin.query(
      `select count(*)::int as total from public.tentativas_venda_manual where organizacao_id = $1 and referencia_local = $2`,
      [ORG_ID, REFERENCIA],
    );
    if (contagem.rows[0].total !== 1) {
      return err('TentativaRaceLinhaDuplicada', `Esperava exatamente UMA linha de tentativa; encontrou ${contagem.rows[0].total}`, { total: contagem.rows[0].total });
    }

    return ok(Object.freeze({
      vencedoraTentativaId: resultadoA.tentativaId,
      perdedoraGraciosa: true,
      bloqueioObservadoNoPostgres: observacao.waitEvent,
      linhasNaTabela: contagem.rows[0].total,
    }));
  } catch (cause) {
    await clientA.query('ROLLBACK').catch(() => {});
    return err('TentativaRaceRehearsalFailed', 'Falha inesperada no rehearsal de concorrência da reivindicação de tentativa', {}, cause);
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
