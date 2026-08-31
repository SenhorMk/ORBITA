/**
 * Semeia o ambiente compartilhado de desenvolvimento com dados sintéticos para
 * a suíte E2E.
 *
 * O ambiente é compartilhado por decisão do proprietário: não existe projeto
 * separado, e os dados reais dali são de teste. A configuração exige
 * confirmação nominal do projeto e do host — isso impede apontar para o destino
 * errado, e **não** substitui isolamento, que não há.
 *
 * A decisão de o que criar, o que já existe e o que retomar mora em
 * `src/lib/e2e/orquestracao.ts`, coberta por teste com falhas simuladas. Este
 * arquivo só liga as peças.
 *
 * Uso:
 *   npm run e2e:seed
 *   npm run e2e:seed -- --retomar <runId>
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { lerDiario } from '../../src/lib/e2e/execucaoSeed';
import { executarSeed } from '../../src/lib/e2e/orquestracao';
import { buildSeedManifest } from '../../src/lib/e2e/syntheticSeedData';

import { caminhoDoDiario, gravarDiarioAtomico, resolverAmbiente } from './ambiente';
import { criarPortaSupabase } from './supabasePorta';

function runIdParaRetomar(): string | undefined {
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const indice = args.indexOf('--retomar');
  return indice >= 0 ? args[indice + 1] : undefined;
}

async function main(): Promise<void> {
  const { supabase, projetoRef } = resolverAmbiente();
  const porta = criarPortaSupabase(supabase);

  const runId = runIdParaRetomar();
  const manifest = buildSeedManifest(runId ? { runId } : {});

  // Na retomada, o diário existente é a única prova do que já foi criado.
  // Montar um plano novo e gravar por cima destruiria essa prova.
  let diarioExistente;
  if (runId) {
    const leitura = lerDiario(
      JSON.parse(readFileSync(caminhoDoDiario(runId), 'utf8')),
      { projetoRef, runId },
    );
    if (leitura._tag !== 'DiarioValido') {
      throw new Error(`Diário de ${runId} recusado (${leitura.motivo._tag}). A retomada não age sobre diário que não confere.`);
    }
    diarioExistente = leitura.diario;
  }

  const { manifest: manifestFinal, diario, recuperadas } = await executarSeed({
    porta,
    manifest,
    projetoRef,
    persistir: (conteudo) => gravarDiarioAtomico(manifest.runId, conteudo),
    diarioExistente,
  });

  const manifestPath = resolve(process.cwd(), `e2e/.manifests/${manifestFinal.runId}.json`);
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(manifestFinal, null, 2), 'utf8');

  process.stdout.write(
    `Seed concluído no projeto ${projetoRef}: run ${manifestFinal.runId}, `
      + `${diario.concluidas.length} registros no diário`
      + (recuperadas > 0 ? `, ${recuperadas} recuperado(s) da execução anterior` : '')
      + `.\nManifest: ${manifestPath}\nDiário:   ${caminhoDoDiario(manifestFinal.runId)}  (é ele que a limpeza usa)\n`
      + `Defina E2E_SEED_MANIFEST_PATH=${manifestPath} antes de rodar \`npm run e2e\`.\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`Falha no seed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
