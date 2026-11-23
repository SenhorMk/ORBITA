/** Real provider smoke: one selected provider or two bounded attempts; synthetic text only. */
import { gerarResposta } from '../src/services/sac/gerarResposta';
import { criarModeloHauxPorAiSdk } from '../src/services/sac/respostaAutomaticaHaux';
import { criarClassificadorHaux, criarRotaHaux, lerProvedoresHaux } from '../src/services/sac/provedoresHaux';
import { executarTriagem } from '../src/services/sac/triagem/triagemDoCaso';
import { createClient } from '@supabase/supabase-js';
import { criarCatalogoComCache } from '../src/services/sac/assistente/catalogo';
import { CONHECIMENTO_PORTAL_DO_HAUX } from '../src/services/sac/assistente/conhecimento';
import { criarLeitorDeProdutos } from '../src/services/sac/assistente/leitorDeProdutos';

/** Catálogo real (somente leitura) quando o ambiente do worker estiver presente. */
function fonteReal() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const chave = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !chave) return undefined;
  const banco = createClient(url, chave, { auth: { persistSession: false, autoRefreshToken: false } });
  return { conhecimento: CONHECIMENTO_PORTAL_DO_HAUX, catalogo: criarCatalogoComCache(criarLeitorDeProdutos(banco), CONHECIMENTO_PORTAL_DO_HAUX) };
}

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
  const pergunta = process.argv.find((s) => s.startsWith('--pergunta='))?.slice('--pergunta='.length) || 'Olá! Boa tarde, tudo bem?';
  const contexto = { marca: 'smoke-real-haux-v1', intencao: 'outro', mensagens: [
    { conteudo: pergunta, criadaEm: new Date().toISOString() },
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
  const inicio = Date.now();
  const resposta = await gerarResposta(async () => contexto, criarModeloHauxPorAiSdk(rota.modelo, rota.provedor, undefined, fonteReal()));
  if (resposta.estado !== 'rascunho') {
    console.error('Smoke real não aprovado:', resposta.estado);
    process.exitCode = 1;
    return;
  }
  console.info(JSON.stringify({ etapa: 'resposta', estado: 'aprovado', provedor: rota.provedor, modelo: rota.identificacao, latenciaMs: Date.now() - inicio, texto: resposta.texto }));
}
void testar().catch(() => { console.error('Smoke real: falha sem exposição de credenciais.'); process.exitCode = 1; });
