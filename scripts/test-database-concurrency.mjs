import {
  alinharStubDeAuthComProducao,
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
import { runConviteNominalRaceRehearsal } from './database-concurrency-convite-nominal.mjs';
import { runItemReplayRaceRehearsal } from './database-concurrency-item-replay.mjs';
import { runFotoDoProdutoRaceRehearsal } from './database-concurrency-foto-produto.mjs';
import { runContaPagarRaceRehearsal } from './database-concurrency-conta-pagar.mjs';
import { runReconciliacaoRaceRehearsal } from './database-concurrency-reconciliacao.mjs';
import { runArquivamentoRaceRehearsal } from './database-concurrency-arquivamento.mjs';
import { runTombstoneRaceRehearsal } from './database-concurrency-tombstone.mjs';
import { runContatoExcluidoRaceRehearsal } from './database-concurrency-contato.mjs';
import { runComandosComerciaisRaceRehearsal } from './database-concurrency-comandos-comerciais.mjs';
import { runMigracoesRemotasRaceRehearsal } from './database-concurrency-migracoes-remotas.mjs';
import { runIdentidadeChatwootRaceRehearsal } from './database-concurrency-identidade-chatwoot.mjs';
import { runOutboxRaceRehearsal } from './database-concurrency-outbox.mjs';
import { runResolverChatwootRaceRehearsal } from './database-concurrency-resolver-chatwoot.mjs';
import { runContracaoChatwootRaceRehearsal } from './database-concurrency-contracao-chatwoot.mjs';
import { failureMessage } from './script-result.mjs';

/**
 * Sobe seu proprio laboratorio descartavel (nao reaproveita o de
 * `database-lab.mjs` — este script roda DEPOIS que aquele ja derrubou o seu),
 * aplica a cadeia canonica de migrations, dispara os rehearsals de
 * concorrencia acumulados — a tomada da linha do webhook, a reivindicacao da
 * MESMA referencia, a exclusao mutua entre referencias DIFERENTES com o mesmo
 * fingerprint, o fencing, a posse da venda, a reserva da venda manual e, do
 * Ticket 06, o aceite nominal de convite — e derruba o laboratorio de novo. Reusa so as pecas ja testadas de `database-lab.mjs` — nao adiciona um
 * passo novo a orquestracao generica de la, que tem teste proprio com fakes.
 */
const [start] = databaseLabCycleSteps('concurrency rehearsal');

let outcomeVenda;
let outcomeTentativa;
let outcomePendencia;
let outcomeFencing;
let outcomePosse;
let outcomeReserva;
let outcomeConvite;
let outcomeItemReplay;
let outcomeFoto;
let outcomeContaPagar;
let outcomeReconciliacao;
let outcomeArquivamento;
let outcomeTombstone;
let outcomeContato;
let outcomeComandosComerciais;
let outcomeMigracoesRemotas;
let outcomeIdentidadeChatwoot;
let outcomeOutbox;
let outcomeResolverChatwoot;
let outcomeContracaoChatwoot;
try {
  const started = executeSupabaseStep(start);
  if (started._tag === 'err') {
    outcomeVenda = started;
    outcomeTentativa = started;
    outcomePendencia = started;
    outcomeFencing = started;
    outcomePosse = started;
    outcomeReserva = started;
    outcomeConvite = started;
    outcomeItemReplay = started;
    outcomeFoto = started;
    outcomeContaPagar = started;
    outcomeReconciliacao = started;
    outcomeArquivamento = started;
    outcomeTombstone = started;
    outcomeContato = started;
    outcomeComandosComerciais = started;
    outcomeMigracoesRemotas = started;
    outcomeIdentidadeChatwoot = started;
    outcomeOutbox = started;
    outcomeResolverChatwoot = started;
    outcomeContracaoChatwoot = started;
  } else {
    const alinhado = await alinharStubDeAuthComProducao();
    const applied = alinhado._tag === 'err' ? alinhado : await applyCanonicalMigrations({});
    if (applied._tag === 'err') {
      outcomeVenda = applied;
      outcomeTentativa = applied;
      outcomePendencia = applied;
      outcomeFencing = applied;
      outcomePosse = applied;
      outcomeReserva = applied;
      outcomeConvite = applied;
      outcomeItemReplay = applied;
      outcomeFoto = applied;
      outcomeContaPagar = applied;
      outcomeReconciliacao = applied;
      outcomeArquivamento = applied;
      outcomeTombstone = applied;
      outcomeContato = applied;
      outcomeComandosComerciais = applied;
      outcomeMigracoesRemotas = applied;
      outcomeIdentidadeChatwoot = applied;
      outcomeOutbox = applied;
      outcomeResolverChatwoot = applied;
      outcomeContracaoChatwoot = applied;
    } else {
      outcomeVenda = await runManualOrderRaceRehearsal();
      outcomeTentativa = await runTentativaClaimRaceRehearsal();
      outcomePendencia = await runPendenciaIdenticaRaceRehearsal();
      outcomeFencing = await runFencingRehearsal();
      outcomePosse = await runPosseDaVendaRehearsal();
      outcomeReserva = await runReservaManualRehearsal();
      outcomeConvite = await runConviteNominalRaceRehearsal();
      outcomeItemReplay = await runItemReplayRaceRehearsal();
      outcomeFoto = await runFotoDoProdutoRaceRehearsal();
      outcomeContaPagar = await runContaPagarRaceRehearsal();
      outcomeReconciliacao = await runReconciliacaoRaceRehearsal();
      outcomeArquivamento = await runArquivamentoRaceRehearsal();
      outcomeTombstone = await runTombstoneRaceRehearsal();
      outcomeContato = await runContatoExcluidoRaceRehearsal();
      outcomeComandosComerciais = await runComandosComerciaisRaceRehearsal();
      outcomeMigracoesRemotas = await runMigracoesRemotasRaceRehearsal();
      outcomeIdentidadeChatwoot = await runIdentidadeChatwootRaceRehearsal();
      outcomeOutbox = await runOutboxRaceRehearsal();
      outcomeResolverChatwoot = await runResolverChatwootRaceRehearsal();
      outcomeContracaoChatwoot = await runContracaoChatwootRaceRehearsal();
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
  [outcomeConvite, (v) => 'aceite nominal de convite provado nas DUAS exclusoes mutuas: dois convites '
    + `disputando o ultimo slot deixam ${v.membrosFinais} membros com bloqueio observado no Postgres `
    + `(wait_event=${v.bloqueioObservadoNoPostgres}), a perdedora falha com ${v.perdedoraCode} e seu `
    + `convite fica ${v.statusDoConviteRecusado}; o mesmo token aceito duas vezes ao mesmo tempo falha `
    + `com ${v.usoUnico.segundaTentativaCode} e deixa ${v.usoUnico.membershipsDoConvidado} membership`],
  [outcomeItemReplay, (v) => v.relato],
  [outcomeFoto, (v) => v.relato],
  [outcomeContaPagar, (v) => v.relato],
  [outcomeReconciliacao, (v) => v.relato],
  [outcomeArquivamento, (v) => v.relato],
  [outcomeTombstone, (v) => v.relato],
  [outcomeContato, (v) => v.relato],
  [outcomeComandosComerciais, (v) => v.relato],
  [outcomeMigracoesRemotas, (v) => v.relato],
  [outcomeIdentidadeChatwoot, (v) => v.relato],
  [outcomeOutbox, (v) => v.relato],
  [outcomeResolverChatwoot, (v) => v.relato],
  [outcomeContracaoChatwoot, (v) => v.relato],
];

const falhou = relatos.map(([outcome, resumo]) => relatar(outcome, resumo)).includes(true);

if (falhou) process.exitCode = 1;
