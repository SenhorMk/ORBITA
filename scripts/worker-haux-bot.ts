/** Operational real-provider worker for the verified Haux G8 connection. */
import { createClient } from '@supabase/supabase-js';
import { setTimeout as esperar } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { ChatwootAdapter } from '../src/services/chatwoot/chatwootAdapter';
import { criarCanalAiFirst } from '../src/services/chatwoot/canalAiFirst';
import { consumirAiFirstUmaVez, ultimaRespostaEntre } from '../src/services/chatwoot/workerAiFirst';
import { criarWorkerAiFirstPorInbox } from '../src/services/chatwoot/workerAiFirstPorInbox';
import { lerUltimaRespostaDaConversa } from '../src/services/chatwoot/espelhoChatwootSupabase';
import { lerUltimoEnvioPublicoDaConversa } from '../src/services/chatwoot/envioChatwoot';
import { verifyOrganizationScope } from '../src/lib/verifiedOrganizationScope';
import { CONEXAO_HAUX, ORGANIZACAO_HAUX, criarModeloHauxPorAiSdk, lerConfiguracaoHaux } from '../src/services/sac/respostaAutomaticaHaux';
import { criarClassificadorHaux, criarRotaHaux } from '../src/services/sac/provedoresHaux';
import { criarCatalogoComCache } from '../src/services/sac/assistente/catalogo';
import { conhecimentoDe } from '../src/services/sac/assistente/conhecimento';
import { criarLeitorDeProdutos } from '../src/services/sac/assistente/leitorDeProdutos';
import { criarPortaDoConsumidorTriagem } from '../src/services/sac/triagem/consumidorTriagemSupabase';
import { consumirTriagensUmaVez } from '../src/services/sac/triagem/consumidorTriagem';

async function iniciar() {
  const config = lerConfiguracaoHaux(process.env);
  if (config._tag === 'Desligado') return;
  if (config._tag !== 'Configurada') {
    console.error('Bot Haux: configuração ausente/inválida:', config.campos.join(', '));
    process.exitCode = 1;
    return;
  }
  const c = config.valor;
  const banco = createClient(c.NEXT_PUBLIC_SUPABASE_URL, c.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } });
  const escopo = { p_org: ORGANIZACAO_HAUX, p_conexao: CONEXAO_HAUX, p_executor: c.CHATWOOT_AI_FIRST_EXECUTOR };
  const criarCanal = (inbox: number) => criarCanalAiFirst({ escopo, inbox, tecnico: c.CHATWOOT_AI_FIRST_ADMIN_ID,
    async resolver() {
      const verificado = await verifyOrganizationScope(banco, { organizationId: ORGANIZACAO_HAUX, actorId: escopo.p_executor });
      if (verificado._tag !== 'OrganizationScopeVerified') return null;
      const adapter = await ChatwootAdapter.forScope(verificado.scope, CONEXAO_HAUX);
      return adapter?.correspondeAOrigemDaProjecao(c.CHATWOOT_AI_FIRST_ORIGEM) ? adapter : null;
    },
  });
  const inboxes = c.HAUX_BOT_INBOXES?.split(',').map(Number);
  if (inboxes && !inboxes.includes(c.CHATWOOT_AI_FIRST_INBOX)) throw new Error('Inbox principal ausente.');
  const porInbox = inboxes ? criarWorkerAiFirstPorInbox({ escopo, banco,
    canais: new Map(inboxes.map(inbox => [inbox, criarCanal(inbox)])),
  }) : null;
  const canal = porInbox?.canal ?? criarCanal(c.CHATWOOT_AI_FIRST_INBOX);
  const bancoDoWorker = porInbox?.banco ?? banco;
  const parada = new AbortController();
  const rota = criarRotaHaux(c, parada.signal);
  const conhecimento = conhecimentoDe(ORGANIZACAO_HAUX);
  const fonte = conhecimento
    ? { conhecimento, catalogo: criarCatalogoComCache(criarLeitorDeProdutos(banco), conhecimento) }
    : undefined;
  const resposta = criarModeloHauxPorAiSdk(rota.modelo, rota.provedor, parada.signal, fonte);
  // Corte do que já foi respondido: a resposta no espelho ou o envio já registrado (segundos antes do espelho).
  const daConexao = (e: typeof escopo) => ({ organizacaoId: e.p_org, conexaoId: e.p_conexao });
  const ultimaResposta = ultimaRespostaEntre(
    (e, conversa) => lerUltimaRespostaDaConversa(banco, daConexao(e), conversa),
    (e, conversa) => lerUltimoEnvioPublicoDaConversa(banco, daConexao(e), conversa));
  const triagem = criarClassificadorHaux(rota);
  const porta = criarPortaDoConsumidorTriagem(banco, escopo);
  const interromper = () => {
    parada.abort();
    void Promise.resolve(banco.rpc('desligar_runtime_ai_first', escopo)).then(({ data, error }) => {
      if (error || data !== true) console.error('Bot Haux: parada local solicitada; fence remoto não confirmado.');
    }).catch(() => console.error('Bot Haux: fence remoto não confirmado.'));
  };
  process.once('SIGINT', interromper);
  process.once('SIGTERM', interromper);
  const workerId = `haux-triagem-${randomUUID()}`;
  try {
    while (!parada.signal.aborted) {
      // Pausa só quando a passada não encontrou trabalho: com projeção, geração
      // ou triagem feita, a próxima passada começa logo (a fila da conversa não
      // espera 2 s por etapa). Fences, cotas e idempotência continuam nas RPCs.
      let houveTrabalho = false;
      try {
        const passo = await consumirAiFirstUmaVez({ escopo, canal, banco: bancoDoWorker, habilitado: true, modelo: resposta,
          ultimaResposta });
        houveTrabalho = passo.estado === 'processado' || ('projecao' in passo && passo.projecao != null);
        if (passo.estado !== 'desligado') {
          const triagens = await consumirTriagensUmaVez(porta, triagem, { workerId, limite: 1, leaseSegundos: 120,
            limiteDiario: c.HAUX_BOT_LIMITE_TRIAGENS_DIA, timeoutMs: 15000, deveParar: () => parada.signal.aborted });
          houveTrabalho ||= triagens.reivindicados > 0;
        }
        console.info('Bot Haux:', passo.estado);
      } catch {
        // Never authorize a dispatch when a provider or control RPC failed.
        await bancoDoWorker.rpc('renovar_worker_ai_first', { ...escopo, p_pronto: false });
        console.error('Bot Haux: passada interrompida; nenhum reenvio forçado.');
      }
      await esperar(houveTrabalho ? 100 : 2000, undefined, { signal: parada.signal }).catch(() => undefined);
    }
  } finally {
    await bancoDoWorker.rpc('renovar_worker_ai_first', { ...escopo, p_pronto: false });
  }
}

void iniciar().catch(() => { console.error('Bot Haux: falha de inicialização.'); process.exitCode = 1; });
