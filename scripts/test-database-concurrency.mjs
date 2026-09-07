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
import { runPosseDaVendaRehearsal } from './database-concurrency-posse-da-venda.mjs';
import { runReservaManualRehearsal } from './database-concurrency-reserva-manual.mjs';
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
let outcomePosse;
let outcomeReserva;
try {
  const started = executeSupabaseStep(start);
  if (started._tag === 'err') {
    outcomeVenda = started;
    outcomeTentativa = started;
    outcomePendencia = started;
    outcomeFencing = started;
    outcomePosse = started;
    outcomeReserva = started;
  } else {
    const applied = await applyCanonicalMigrations({});
    if (applied._tag === 'err') {
      outcomeVenda = applied;
      outcomeTentativa = applied;
      outcomePendencia = applied;
      outcomeFencing = applied;
      outcomePosse = applied;
      outcomeReserva = applied;
    } else {
      outcomeVenda = await runManualOrderRaceRehearsal();
      outcomeTentativa = await runTentativaClaimRaceRehearsal();
      outcomePendencia = await runPendenciaIdenticaRaceRehearsal();
      outcomeFencing = await runFencingRehearsal();
      outcomePosse = await runPosseDaVendaRehearsal();
      outcomeReserva = await runReservaManualRehearsal();
    }
  }
} finally {
  executeSupabaseStep(DATABASE_LAB_CLEANUP);
}

/**
 * Relata um rehearsal. Extraído porque os seis relatos eram o MESMO bloco
 * `if (err) console.error … else console.log …` copiado, e o gate de qualidade
 * sinaliza bloco duplicado — com razão: o sexto foi colado do quinto.
 *
 * @param {object} outcome - Resultado tagueado do rehearsal.
 * @param {(valor: Record<string, unknown>) => string} resumo - A linha de evidência do caso feliz.
 * @returns {boolean} `true` quando o rehearsal falhou.
 */
function relatar(outcome, resumo) {
  if (outcome._tag === 'err') {
    console.error(`[database-concurrency] ${outcome.error._tag}: ${failureMessage(outcome.error)}`);
    return true;
  }
  console.log(`[database-concurrency] ${resumo(outcome.value)}`);
  return false;
}

const relatos = [
  [outcomeVenda, (v) => 'atomicidade da tomada provada com bloqueio observado no Postgres '
    + `(wait_event=${v.bloqueioObservadoNoPostgres}): vencedora ${v.vencedora}, perdedora ${v.perdedoraCode}, `
    + `estoque ${v.estoqueFinal}, reservado ${v.estoqueReservadoFinal}`],
  [outcomeTentativa, (v) => 'atomicidade da reivindicação de tentativa provada com bloqueio observado no Postgres '
    + `(wait_event=${v.bloqueioObservadoNoPostgres}): vencedora ${v.vencedoraTentativaId}, `
    + `perdedora graciosa=${v.perdedoraGraciosa}, linhas na tabela=${v.linhasNaTabela}`],
  [outcomePendencia, (v) => 'exclusão mútua de pendência idêntica provada com bloqueio observado no Postgres '
    + `(wait_event=${v.bloqueioObservadoNoPostgres}): referências DIFERENTES para a MESMA venda, `
    + `vencedora ${v.vencedora}, perdedora apontou ${v.perdedoraApontou}, `
    + `tentativas no fingerprint=${v.tentativasNoFingerprint}`],
  [outcomeFencing, (v) => `fencing provado: a reconciliação tomou a posse (época ${v.epocaDoOriginal} → `
    + `${v.epocaDepoisDaTomada}) e a escrita do executor anterior foi recusada com `
    + `${v.escritaDoZumbiRecusadaCom}; estado final ${v.estadoFinal}`],
  [outcomePosse, (v) => `posse da venda provada: a reconciliação tomou a posse (época ${v.epocaDoOriginal} → `
    + `${v.epocaDepoisDaTomada}) e a gravação do executor cercado foi recusada com `
    + `${v.gravacaoDoZumbiRecusadaCom} sem efeito residual (pedidos=${v.pedidosDoZumbi}, `
    + `estoque=${v.estoquePreservado}); com a posse vigente, o ledger fecha na mesma transação `
    + `(${v.ledgerConcluidoNaMesmaTransacao})`],
  [outcomeReserva, (v) => 'reserva da venda manual provada nas DUAS ordens: venda→webhook deixa '
    + `disponibilidade ${v.ordem1DisponibilidadeFinal} e reserva ${v.ordem1ReservaFinal} `
    + `(webhook concluiu: ${v.ordem1WebhookOk}); webhook→venda libera a reserva `
    + `${v.ordem2ReservaDoWebhook} → ${v.ordem2ReservaAposTomada}, `
    + `disponibilidade final ${v.ordem2DisponibilidadeFinal}`],
];

const falhou = relatos.map(([outcome, resumo]) => relatar(outcome, resumo)).includes(true);

if (falhou) process.exitCode = 1;
