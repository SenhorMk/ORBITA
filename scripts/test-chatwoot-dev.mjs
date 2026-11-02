import {
  alinharStubDeAuthComProducao,
  applyCanonicalMigrations,
  databaseLabCycleSteps,
  DATABASE_LAB_CLEANUP,
  executeSupabaseStep,
} from './database-lab.mjs';
import { rodarProvaComPostgrest } from './database-integracao-consumidor-inbox.mjs';
import { compose, esperarChatwoot, PORTA_DA_PROVA, segredosDaProva, VERSAO_FIXADA } from './chatwoot-dev.mjs';
import { err, failureMessage } from './script-result.mjs';

/**
 * MSG-001. Sobe o Chatwoot CE fixado do zero, num projeto Docker próprio e com
 * segredos só desta execução, e roda a prova contra ele. Ao final apaga o projeto.
 */

const segredos = segredosDaProva();
Object.assign(process.env, segredos);
const base = `http://127.0.0.1:${PORTA_DA_PROVA}`;

async function subirChatwootDoZero() {
  compose(['down', '-v', '--remove-orphans']);
  const bancos = compose(['up', '-d', '--wait', 'postgres', 'redis']);
  if (bancos.status !== 0) throw new Error(`Postgres/Redis não subiram: ${String(bancos.stderr).slice(-400)}`);
  const preparo = compose(['run', '--rm', '--no-deps', 'rails', 'bundle', 'exec', 'rails', 'db:chatwoot_prepare']);
  if (preparo.status !== 0) throw new Error(`Preparo do banco falhou: ${String(preparo.stderr).slice(-400)}`);
  // Sem esta conferência, outra instância na mesma porta passaria pela da prova.
  const aplicacao = compose(['up', '-d', 'rails', 'sidekiq']);
  if (aplicacao.status !== 0) throw new Error(`Rails/Sidekiq não subiram: ${String(aplicacao.stderr).slice(-400)}`);
  const versao = await esperarChatwoot(base);
  if (versao !== VERSAO_FIXADA) throw new Error(`Versão inesperada do Chatwoot: ${versao}`);
}

let resultado;
try {
  await subirChatwootDoZero();
  const [start] = databaseLabCycleSteps('prova do Chatwoot');
  const iniciado = executeSupabaseStep(start);
  const alinhado = iniciado._tag === 'err' ? iniciado : await alinharStubDeAuthComProducao();
  const aplicado = alinhado._tag === 'err' ? alinhado : await applyCanonicalMigrations({});
  resultado = aplicado._tag === 'err' ? aplicado : await rodarProvaComPostgrest({
    config: 'vitest.chatwoot-real.config.ts',
    env: { CHATWOOT_REAL_URL: base, CHATWOOT_REAL_SENHA_POSTGRES: segredos.CHATWOOT_POSTGRES_PASSWORD },
    relato: (testes) => `prova do MSG-001 contra o Chatwoot CE ${VERSAO_FIXADA} real: ${testes} testes`,
  });
} catch (causa) {
  resultado = err('ChatwootDevFalhou', causa instanceof Error ? causa.message : 'Falha inesperada');
} finally {
  if (resultado?._tag !== 'ok') {
    const estado = compose(['ps', '-a', '--format', '{{.Service}} {{.State}} {{.ExitCode}}']);
    const logs = compose(['logs', '--tail', '15', 'rails']);
    console.error(`[chatwoot-dev] estado dos serviços:
${estado.stdout}
${String(logs.stdout).slice(-1500)}`);
  }
  executeSupabaseStep(DATABASE_LAB_CLEANUP);
  compose(['down', '-v', '--remove-orphans']);
}

if (resultado._tag === 'err') {
  console.error(`[chatwoot-dev] ${resultado.error._tag}: ${failureMessage(resultado.error)}`);
  process.exitCode = 1;
} else {
  console.log(`[chatwoot-dev] ${resultado.value.relato}`);
}
