import {
  applyCanonicalMigrations,
  databaseLabCycleSteps,
  DATABASE_LAB_CLEANUP,
  executeSupabaseStep,
} from './database-lab.mjs';
import { runManualOrderRaceRehearsal } from './database-concurrency.mjs';
import { runTentativaClaimRaceRehearsal } from './database-concurrency-tentativas.mjs';
import { failureMessage } from './script-result.mjs';

/**
 * Sobe seu proprio laboratorio descartavel (nao reaproveita o de
 * `database-lab.mjs` — este script roda DEPOIS que aquele ja derrubou o seu),
 * aplica a cadeia canonica de migrations, dispara os dois rehearsals de
 * concorrencia do ticket 30 (a tomada da linha do webhook, e a reivindicacao
 * de tentativa — 3ª e 4ª rodadas de revisao), e derruba o laboratorio de
 * novo. Reusa so as pecas ja testadas de `database-lab.mjs` — nao adiciona um
 * passo novo a orquestracao generica de la, que tem teste proprio com fakes.
 */
const [start] = databaseLabCycleSteps('concurrency rehearsal');

let outcomeVenda;
let outcomeTentativa;
try {
  const started = executeSupabaseStep(start);
  if (started._tag === 'err') {
    outcomeVenda = started;
    outcomeTentativa = started;
  } else {
    const applied = await applyCanonicalMigrations({});
    if (applied._tag === 'err') {
      outcomeVenda = applied;
      outcomeTentativa = applied;
    } else {
      outcomeVenda = await runManualOrderRaceRehearsal();
      outcomeTentativa = await runTentativaClaimRaceRehearsal();
    }
  }
} finally {
  executeSupabaseStep(DATABASE_LAB_CLEANUP);
}

let falhou = false;

if (outcomeVenda._tag === 'err') {
  console.error(`[database-concurrency] ${outcomeVenda.error._tag}: ${failureMessage(outcomeVenda.error)}`);
  falhou = true;
} else {
  console.log(
    `[database-concurrency] atomicidade da tomada provada com bloqueio observado no Postgres (wait_event=${outcomeVenda.value.bloqueioObservadoNoPostgres}): `
      + `vencedora ${outcomeVenda.value.vencedora}, perdedora ${outcomeVenda.value.perdedoraCode}, `
      + `estoque ${outcomeVenda.value.estoqueFinal}, reservado ${outcomeVenda.value.estoqueReservadoFinal}`,
  );
}

if (outcomeTentativa._tag === 'err') {
  console.error(`[database-concurrency] ${outcomeTentativa.error._tag}: ${failureMessage(outcomeTentativa.error)}`);
  falhou = true;
} else {
  console.log(
    `[database-concurrency] atomicidade da reivindicação de tentativa provada com bloqueio observado no Postgres `
      + `(wait_event=${outcomeTentativa.value.bloqueioObservadoNoPostgres}): vencedora ${outcomeTentativa.value.vencedoraTentativaId}, `
      + `perdedora graciosa=${outcomeTentativa.value.perdedoraGraciosa}, linhas na tabela=${outcomeTentativa.value.linhasNaTabela}`,
  );
}

if (falhou) process.exitCode = 1;
