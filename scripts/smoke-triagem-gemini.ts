/**
 * Smoke da triagem com o Gemini Flash real (MSG-013, D3): `npm run smoke:triagem`.
 *
 * Só fixtures sintéticas, sem banco e sem worker. A chave vem do ambiente
 * (ou do `.env.local`, lido pelo Node), nunca de argumento, e nunca é
 * impressa. Sem `--confirmar`, mostra o plano e não chama o provedor. No plano
 * gratuito o Google pode usar o conteúdo enviado: por isso só sintético.
 */
import fs from 'node:fs';

import { criarModeloGemini, MODELO_GEMINI_APROVADO } from '../src/services/sac/triagem/modelosDeTriagem';
import { FIXTURES_DA_TRIAGEM, rodarSmokeDaTriagem } from '../src/services/sac/triagem/smokeDaTriagem';

if (fs.existsSync('.env.local')) process.loadEnvFile('.env.local');

const modelo = process.env.SAC_TRIAGEM_MODELO ?? '';
const chave = process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? '';
const timeoutMs = Number(process.env.SAC_TRIAGEM_TIMEOUT_MS ?? 20_000);
const paraModelo = FIXTURES_DA_TRIAGEM.filter((f) => f.intencoes.length > 0).length;

const faltando = [
  ...(MODELO_GEMINI_APROVADO.test(modelo) ? [] : ['SAC_TRIAGEM_MODELO (um Flash de texto aprovado, ex.: gemini-2.5-flash)']),
  ...(chave.length >= 20 ? [] : ['GOOGLE_GENERATIVE_AI_API_KEY']),
];
console.log(`Smoke da triagem: ${FIXTURES_DA_TRIAGEM.length} fixtures sintéticas, ${paraModelo} chegam ao modelo, no máximo ${paraModelo * 2} chamadas (uma reparação cada).`);
if (faltando.length > 0) {
  console.error(`Falta no ambiente: ${faltando.join('; ')}. Nada foi chamado.`);
  process.exit(1);
}
if (!process.argv.includes('--confirmar')) {
  console.log(`Modelo: ${modelo}. Somente o plano. Para chamar o provedor: npm run smoke:triagem -- --confirmar`);
  process.exit(0);
}

void (async () => {
  const relatorio = await rodarSmokeDaTriagem(criarModeloGemini({ chave, modelo }), { timeoutMs });
  for (const r of relatorio.resultados) {
    console.log([r.id, r.status, r.motivo ?? '-', r.intencao ?? '-', r.esperado ? 'esperado' : 'INESPERADO',
      `modelo=${r.chamouModelo}`, `tokens=${r.tokensEntrada}/${r.tokensSaida}`, `reparos=${r.reparos}`, `${r.latenciaMs}ms`].join(' | '));
  }
  console.log(`Schema validado: ${relatorio.schemaValidado}/${paraModelo}; intenção esperada: ${relatorio.esperados}/${relatorio.resultados.length}; `
    + `chamadas com modelo: ${relatorio.comModelo}; tokens: ${relatorio.tokensEntrada} entrada, ${relatorio.tokensSaida} saída; `
    + `${relatorio.provedor}/${relatorio.modelo}; ${relatorio.aprovado ? 'APROVADO' : 'REPROVADO'}`);
  process.exitCode = relatorio.aprovado ? 0 : 1;
})().catch(() => {
  console.error('Smoke da triagem: falha inesperada.');
  process.exitCode = 1;
});
