/** Real provider smoke: one selected provider or two bounded attempts; synthetic text only. */
import { gerarResposta } from '../src/services/sac/gerarResposta';
import { criarModeloHauxPorAiSdk } from '../src/services/sac/respostaAutomaticaHaux';
import { criarClassificadorHaux, criarRotaHaux, lerProvedoresHaux } from '../src/services/sac/provedoresHaux';
import { executarTriagem } from '../src/services/sac/triagem/triagemDoCaso';

async function testar() {
  const lida = lerProvedoresHaux(process.env);
  const modo = process.argv.find((s) => s.startsWith('--provedor='))?.split('=')[1] ?? 'rota';
  const primeiro = process.argv.find((s) => s.startsWith('--primeiro='))?.split('=')[1];
  if (!lida.success || !['google', 'groq', 'rota'].includes(modo) || (primeiro && !['google', 'groq'].includes(primeiro))) {
    console.error('Smoke real pendente: configuração dos provedores ou argumentos inválidos; nenhum segredo exibido.');
    process.exitCode = 1;
    return;
  }
  const config = lida.data;
  if (primeiro === 'google' || primeiro === 'groq') config.HAUX_AI_PRIMARY = primeiro;
  const rota = criarRotaHaux(config, undefined, modo === 'google' || modo === 'groq' ? modo : undefined);
  const contexto = { marca: 'smoke-real-haux-v1', intencao: 'outro', mensagens: [
    { conteudo: 'Olá! Boa tarde, tudo bem?', criadaEm: new Date().toISOString() },
  ] };
  if (process.argv.includes('--triagem')) {
    const resultado = await executarTriagem(contexto.mensagens,
      criarClassificadorHaux(rota), { timeoutMs: 15000 });
    const aprovado = resultado.status === 'concluida' && !resultado.triagem.precisaDeHumano && resultado.triagem.confianca === 'alta';
    console.info(JSON.stringify({ etapa: 'triagem', estado: aprovado ? 'aprovado' : 'nao_aprovado', provedor: rota.provedor,
      resultado: resultado.status, ...(resultado.status === 'concluida' ? { intencao: resultado.triagem.intencao, confianca: resultado.triagem.confianca } : {}) }));
    if (!aprovado) process.exitCode = 1;
    return;
  }
  const resposta = await gerarResposta(async () => contexto, criarModeloHauxPorAiSdk(rota.modelo, rota.provedor));
  if (resposta.estado !== 'rascunho') {
    console.error('Smoke real não aprovado:', resposta.estado);
    process.exitCode = 1;
    return;
  }
  console.info(JSON.stringify({ etapa: 'resposta', estado: 'aprovado', provedor: rota.provedor, modelo: rota.identificacao, textoSintetico: resposta.texto }));
}
void testar().catch(() => { console.error('Smoke real: falha sem exposição de credenciais.'); process.exitCode = 1; });
