import { createLocalDatabaseClient } from './local-database-client.mjs';
import { esperar, observarBloqueioNoPostgres } from './database-concurrency.mjs';
import { err, ok } from './script-result.mjs';

/**
 * Ticket 30, fatia 3 — 7ª rodada de revisão.
 *
 * Prova a exclusão mútua entre tentativas com `referencia_local` DIFERENTES e
 * o MESMO fingerprint, dentro da mesma organização.
 *
 * ## O defeito que este rehearsal existe para pegar
 *
 * A guarda de "pendência idêntica" da 6ª rodada era:
 *
 *   1. `INSERT` da referência nova;
 *   2. `SELECT` procurando outra tentativa sem desfecho com o mesmo
 *      `(organizacao_id, fingerprint)`;
 *   3. se achasse, `DELETE` da recém-inserida.
 *
 * Isso protege contra a MESMA referência (o índice único de
 * `(organizacao_id, referencia_local)` faz esse trabalho), e **não protege**
 * contra referências DIFERENTES: em `READ COMMITTED`, a transação A insere
 * `RA/X` e a B insere `RB/X`, e o `SELECT` de cada uma **não enxerga a linha
 * ainda não commitada da outra**. As duas passam pelo passo 2 sem achar nada,
 * as duas devolvem "tentativa nova", e as duas chegam ao Bling.
 *
 * ## A barreira
 *
 * A mesma das outras ensaiadas: A abre transação explícita e reivindica
 * `RA/X` sem commitar; B reivindica `RB/X` concorrentemente. O que se observa
 * depois é o que distingue o código defeituoso do corrigido:
 *
 * - **defeituoso:** B **não bloqueia** e devolve "tentativa nova" na hora —
 *   dois vencedores, e é isso que `esperado: 'dois-vencedores'` documenta;
 * - **corrigido:** B **bloqueia** no índice único parcial (observável em
 *   `pg_stat_activity`), e quando A commita, B destrava devolvendo a
 *   referência pendente de A, sem nunca virar uma segunda autorização.
 *
 * O rehearsal roda com `esperado` explícito para poder ser usado nas duas
 * direções: reproduzindo o defeito antes da correção e provando a correção
 * depois.
 */

const ORG_ID = 'd0000000-0000-4000-8000-000000000001';
const ORG_VIZINHA_ID = 'd0000000-0000-4000-8000-000000000009';
const OWNER_ID = 'd0000000-0000-4000-8000-000000000002';
const REFERENCIA_A = 'ORBITA-pendencia-a';
const REFERENCIA_B = 'ORBITA-pendencia-b';
const FINGERPRINT = 'fingerprint-da-mesma-venda';
const VALORES = 'valores-da-mesma-venda';

async function seed(client) {
  await client.query(
    `insert into auth.users (id, email) values ($1, 'owner-pendencia-t30@orbita.test') on conflict (id) do nothing`,
    [OWNER_ID],
  );
  await client.query(
    `insert into public.organizacoes (id, nome, slug) values
       ($1, 'Org Pendencia T30', 'org-pendencia-t30'),
       ($2, 'Org Vizinha T30', 'org-vizinha-t30')
     on conflict (id) do nothing`,
    [ORG_ID, ORG_VIZINHA_ID],
  );
  await client.query(
    `insert into public.membros_organizacao (organizacao_id, user_id, papel) values ($1, $2, 'owner')
     on conflict (organizacao_id, user_id) do nothing`,
    [ORG_ID, OWNER_ID],
  );
}

const SQL_REIVINDICAR = `select * from public.reivindicar_tentativa_venda_manual($1, $2, $3, $4)`;

async function reivindicar(client, organizacaoId, referencia) {
  try {
    const resultado = await client.query(SQL_REIVINDICAR, [organizacaoId, referencia, FINGERPRINT, VALORES]);
    const linha = resultado.rows[0];
    return {
      ok: true,
      tentativaId: linha.tentativa_id,
      isDuplicate: linha.is_duplicate,
      referenciaPendente: linha.referencia_pendente,
      /** "Ganhou autorização para efeito externo" é exatamente isto: id novo, sem pendência apontada. */
      autorizada: linha.tentativa_id !== null && !linha.referencia_pendente,
    };
  } catch (cause) {
    return { ok: false, code: cause?.code, message: cause?.message };
  }
}

/**
 * Duas referências DIFERENTES para a MESMA venda, concorrentes.
 *
 * @param {object} [options] - Fábrica de clientes, janela de observação e expectativa.
 * @param {'exclusao-mutua' | 'dois-vencedores'} [options.esperado] - O que se espera observar.
 * @returns {Promise<{ readonly _tag: 'ok', readonly value: Readonly<Record<string, unknown>> } | { readonly _tag: 'err', readonly error: Readonly<Record<string, unknown>> }>} Evidência ou falha tagueada.
 */
export async function runPendenciaIdenticaRaceRehearsal({
  createClient = () => createLocalDatabaseClient('orbita-database-concurrency-pendencia'),
  timeoutDeObservacaoMs = 3000,
  esperado = 'exclusao-mutua',
} = {}) {
  const admin = createClient();
  const clientA = createClient();
  const clientB = createClient();
  try {
    await admin.connect();
    await seed(admin);
    await clientA.connect();
    await clientB.connect();

    // ---- A reivindica RA/X dentro de transação aberta, sem commitar. ----
    await clientA.query('BEGIN');
    const resultadoA = await reivindicar(clientA, ORG_ID, REFERENCIA_A);
    if (!resultadoA.ok || !resultadoA.autorizada) {
      await clientA.query('ROLLBACK');
      return err(
        'PendenciaRacePrimeiraFalhou',
        'A primeira reivindicação (chave limpa) deveria ter sido autorizada; falhou antes de haver concorrência',
        { resultadoA },
      );
    }

    // ---- B reivindica RB/X — MESMO fingerprint, referência DIFERENTE. ----
    const pidDeB = (await clientB.query('select pg_backend_pid() as pid')).rows[0].pid;
    const promiseB = reivindicar(clientB, ORG_ID, REFERENCIA_B);

    const observacao = await observarBloqueioNoPostgres(admin, pidDeB, { timeoutMs: timeoutDeObservacaoMs });

    if (esperado === 'dois-vencedores') {
      // Reprodução do defeito: B NÃO bloqueia e resolve sozinha.
      const resultadoBSemEspera = await Promise.race([promiseB, esperar(500).then(() => null)]);
      await clientA.query('COMMIT');
      const resultadoB = resultadoBSemEspera ?? (await promiseB);
      const doisVencedores = resultadoA.autorizada && resultadoB.ok && resultadoB.autorizada;
      if (!doisVencedores) {
        return err(
          'PendenciaRaceDefeitoNaoReproduzido',
          'Esperava reproduzir DOIS vencedores com o código sem proteção atômica, e não reproduziu',
          { resultadoA, resultadoB, bloqueou: observacao.observado },
        );
      }
      return ok(Object.freeze({
        defeitoReproduzido: true,
        bloqueou: observacao.observado,
        vencedoraA: resultadoA.tentativaId,
        vencedoraB: resultadoB.tentativaId,
      }));
    }

    // ---- Correção: B tem de BLOQUEAR até A decidir. ----
    if (!observacao.observado) {
      await clientA.query('ROLLBACK').catch(() => {});
      const resultadoBSeJaResolveu = await Promise.race([promiseB, esperar(50).then(() => undefined)]);
      return err(
        'PendenciaRaceNaoBloqueou',
        'pg_stat_activity nunca marcou B como esperando um Lock: a exclusão mútua entre referências '
          + 'diferentes com o mesmo fingerprint não está sendo imposta pelo banco',
        { pidDeB, resultadoBSeJaResolveu },
      );
    }

    await clientA.query('COMMIT');
    const resultadoB = await promiseB;

    if (!resultadoB.ok) {
      return err(
        'PendenciaRaceLancouErro',
        'A perdedora deveria devolver a referência pendente graciosamente, não lançar',
        { resultadoA, resultadoB },
      );
    }
    if (resultadoB.autorizada) {
      return err(
        'PendenciaRaceDoisVencedores',
        'Duas referências DIFERENTES para a MESMA venda ganharam autorização para efeito externo',
        { resultadoA, resultadoB },
      );
    }
    if (resultadoB.referenciaPendente !== REFERENCIA_A) {
      return err(
        'PendenciaRaceReferenciaErrada',
        `A perdedora deveria apontar a pendência de A (${REFERENCIA_A}); apontou ${String(resultadoB.referenciaPendente)}`,
        { resultadoB },
      );
    }

    // ---- Sem resíduo: a linha da perdedora não pode ter ficado no ledger. ----
    const linhas = await admin.query(
      `select count(*)::int as total from public.tentativas_venda_manual
        where organizacao_id = $1 and fingerprint = $2`,
      [ORG_ID, FINGERPRINT],
    );
    if (linhas.rows[0].total !== 1) {
      return err(
        'PendenciaRaceResiduo',
        `Esperava exatamente UMA tentativa para o fingerprint; encontrou ${linhas.rows[0].total}`,
        { total: linhas.rows[0].total },
      );
    }

    // ---- Isolamento: outra organização com a MESMA venda não é bloqueada. ----
    const resultadoVizinha = await reivindicar(clientB, ORG_VIZINHA_ID, REFERENCIA_A);
    if (!resultadoVizinha.ok || !resultadoVizinha.autorizada) {
      return err(
        'PendenciaRaceIsolamentoQuebrado',
        'A pendência de uma organização bloqueou a mesma venda em OUTRA organização',
        { resultadoVizinha },
      );
    }

    // ---- Resolvida a pendência, a mesma venda volta a poder existir. ----
    await admin.query(
      `select public.concluir_tentativa_venda_manual($1, $2, 'concluida', null, '918273')`,
      [ORG_ID, resultadoA.tentativaId],
    );
    const depoisDeResolver = await reivindicar(clientB, ORG_ID, REFERENCIA_B);
    if (!depoisDeResolver.ok || !depoisDeResolver.autorizada) {
      return err(
        'PendenciaRaceNaoLiberouDepoisDeResolver',
        'Depois da pendência ser resolvida, uma segunda venda legitimamente idêntica deveria poder existir',
        { depoisDeResolver },
      );
    }

    return ok(Object.freeze({
      bloqueioObservadoNoPostgres: observacao.waitEvent,
      vencedora: resultadoA.tentativaId,
      perdedoraApontou: resultadoB.referenciaPendente,
      tentativasNoFingerprint: linhas.rows[0].total,
      outraOrganizacaoNaoBloqueada: true,
      reabreDepoisDeResolver: true,
    }));
  } catch (cause) {
    await clientA.query('ROLLBACK').catch(() => {});
    return err('PendenciaRaceRehearsalFailed', 'Falha inesperada no rehearsal de pendência idêntica', {}, cause);
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
