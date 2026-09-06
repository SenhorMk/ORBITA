import {
  applyCanonicalMigrations,
  databaseLabCycleSteps,
  DATABASE_LAB_CLEANUP,
  executeSupabaseStep,
} from './database-lab.mjs';
import { runManualOrderRaceRehearsal } from './database-concurrency.mjs';
import { runTentativaClaimRaceRehearsal } from './database-concurrency-tentativas.mjs';
import { runPendenciaIdenticaRaceRehearsal } from './database-concurrency-pendencia.mjs';
import { runFencingRehearsal } from './database-concurrency-fencing.mjs';
import { failureMessage } from './script-result.mjs';

/**
 * Sobe seu proprio laboratorio descartavel (nao reaproveita o de
 * `database-lab.mjs` — este script roda DEPOIS que aquele ja derrubou o seu),
 * aplica a cadeia canonica de migrations, dispara os tres rehearsals de
 * concorrencia do ticket 30 — a tomada da linha do webhook (3ª rodada), a
 * reivindicacao da MESMA referencia (4ª), e a exclusao mutua entre
 * referencias DIFERENTES com o mesmo fingerprint (7ª) — e derruba o
 * laboratorio de novo. Reusa so as pecas ja testadas de `database-lab.mjs` — nao adiciona um
 * passo novo a orquestracao generica de la, que tem teste proprio com fakes.
 */
const [start] = databaseLabCycleSteps('concurrency rehearsal');

let outcomeVenda;
let outcomeTentativa;
let outcomePendencia;
let outcomeFencing;
try {
  const started = executeSupabaseStep(start);
  if (started._tag === 'err') {
    outcomeVenda = started;
    outcomeTentativa = started;
    outcomePendencia = started;
    outcomeFencing = started;
  } else {
    const applied = await applyCanonicalMigrations({});
    if (applied._tag === 'err') {
      outcomeVenda = applied;
      outcomeTentativa = applied;
      outcomePendencia = applied;
      outcomeFencing = applied;
    } else {
      outcomeVenda = await runManualOrderRaceRehearsal();
      outcomeTentativa = await runTentativaClaimRaceRehearsal();
      outcomePendencia = await runPendenciaIdenticaRaceRehearsal();
      outcomeFencing = await runFencingRehearsal();
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

if (outcomePendencia._tag === 'err') {
  console.error(`[database-concurrency] ${outcomePendencia.error._tag}: ${failureMessage(outcomePendencia.error)}`);
  falhou = true;
} else {
  console.log(
    `[database-concurrency] exclusão mútua de pendência idêntica provada com bloqueio observado no Postgres `
      + `(wait_event=${outcomePendencia.value.bloqueioObservadoNoPostgres}): referências DIFERENTES para a MESMA venda, `
      + `vencedora ${outcomePendencia.value.vencedora}, perdedora apontou ${outcomePendencia.value.perdedoraApontou}, `
      + `tentativas no fingerprint=${outcomePendencia.value.tentativasNoFingerprint}`,
  );
}

if (outcomeFencing._tag === 'err') {
  console.error(`[database-concurrency] ${outcomeFencing.error._tag}: ${failureMessage(outcomeFencing.error)}`);
  falhou = true;
} else {
  console.log(
    `[database-concurrency] fencing provado: a reconciliação tomou a posse (época ${outcomeFencing.value.epocaDoOriginal} → `
      + `${outcomeFencing.value.epocaDepoisDaTomada}) e a escrita do executor anterior foi recusada com `
      + `${outcomeFencing.value.escritaDoZumbiRecusadaCom}; estado final ${outcomeFencing.value.estadoFinal}`,
  );
}

if (falhou) process.exitCode = 1;
