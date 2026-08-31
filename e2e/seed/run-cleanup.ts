/**
 * Apaga o que uma execução de seed criou no ambiente compartilhado — e nada
 * além.
 *
 * A decisão de o que pode ser apagado mora em `src/lib/e2e/limpezaSegura.ts` e
 * `orquestracao.ts`, cobertas por teste com falhas simuladas. Este arquivo só
 * liga as peças e imprime.
 *
 * Uso:
 *   npm run e2e:cleanup -- <runId> --simular   (não apaga nada)
 *   npm run e2e:cleanup -- <runId>
 */
import { readFileSync } from 'node:fs';

import { lerDiario } from '../../src/lib/e2e/execucaoSeed';
import { executarLimpeza } from '../../src/lib/e2e/orquestracao';

import { caminhoDoDiario, resolverAmbiente } from './ambiente';
import { criarPortaSupabase } from './supabasePorta';

function lerArgumentos(): { runId: string; simular: boolean } {
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const runId = args.find((a) => !a.startsWith('--'));
  if (!runId) {
    throw new Error('Uso: npm run e2e:cleanup -- <runId> [--simular]');
  }
  return { runId, simular: args.includes('--simular') };
}

async function main(): Promise<void> {
  const { runId, simular } = lerArgumentos();
  const { supabase, projetoRef } = resolverAmbiente();

  const leitura = lerDiario(JSON.parse(readFileSync(caminhoDoDiario(runId), 'utf8')), { projetoRef, runId });
  if (leitura._tag !== 'DiarioValido') {
    throw new Error(
      `Diário recusado (${leitura.motivo._tag}). A limpeza não age sobre um diário que não confere com o `
        + `projeto autorizado (${projetoRef}) e a execução ${runId}.`,
    );
  }

  const resultado = await executarLimpeza(criarPortaSupabase(supabase), leitura.diario, { simular });

  process.stdout.write(`${resultado.simulacao}\n`);

  if (resultado.orfaos.length > 0) {
    // Informativo por decisão: apagar por varredura é o que a conferência de
    // identidade existe para impedir. Quem decide é quem está operando.
    process.stdout.write(
      `\nÓRFÃOS desta execução (${resultado.orfaos.length}) — informativo, nada será apagado:\n`
        + resultado.orfaos.map((o) => `  ${o.identificador}  id=${o.id}`).join('\n') + '\n',
    );
  }

  process.stdout.write(
    resultado.simulado
      ? '\nSimulação: nada foi apagado.\n'
      : `\nLimpeza concluída: ${resultado.removidos} removido(s), `
        + `${resultado.plano.jaRemovidas.length} já não existia(m).\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`Falha na limpeza: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
