/** A single real model call with synthetic text; no Chatwoot or database mutation. */
import { gerarResposta } from '../src/services/sac/gerarResposta';
import { criarModeloHaux } from '../src/services/sac/respostaAutomaticaHaux';
import { MODELO_GEMINI_APROVADO } from '../src/services/sac/triagem/modelosDeTriagem';

async function testar() {
  const chave = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  const modelo = process.env.SAC_RESPOSTA_MODELO;
  if (!chave || !modelo || !MODELO_GEMINI_APROVADO.test(modelo)) {
    console.error('Smoke real pendente: GOOGLE_GENERATIVE_AI_API_KEY e SAC_RESPOSTA_MODELO são obrigatórios.');
    process.exitCode = 1;
    return;
  }
  const contexto = { marca: 'smoke-real-haux-v1', intencao: 'outro', mensagens: [
    { conteudo: 'Olá! Boa tarde, tudo bem?', criadaEm: new Date().toISOString() },
  ] };
  const resposta = await gerarResposta(async () => contexto, criarModeloHaux(chave, modelo));
  if (resposta.estado !== 'rascunho' || resposta.provedor !== 'google') {
    console.error('Smoke real não aprovado:', resposta.estado);
    process.exitCode = 1;
    return;
  }
  console.info(JSON.stringify({ estado: 'aprovado', provedor: 'google', modelo, textoSintetico: resposta.texto }));
}
void testar().catch(() => { console.error('Smoke real: falha sem exposição de credenciais.'); process.exitCode = 1; });
