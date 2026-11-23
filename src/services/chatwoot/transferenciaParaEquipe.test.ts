import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { consumirAiFirstUmaVez, type CanalDeProjecaoAiFirst } from './workerAiFirst';
import { criarModeloHauxPorAiSdk } from '../sac/respostaAutomaticaHaux';
import { CONHECIMENTO_PORTAL_DO_HAUX } from '../sac/assistente/conhecimento';

/**
 * Transferência para a equipe: decisão do modelo → pedido (concluir sem
 * texto) → confirmação (RPC `escalonada` ou estado persistido) → mensagem ao
 * cliente (nenhuma promessa sai sem transferência). Prova por dublês: o
 * banco é simulado aqui; as regras de controle, fencing e idempotência do
 * banco estão provadas nos pgTAP `controle_atendimento_chatwoot` e
 * `autorresposta_sac` (job "Disposable Supabase database lab" do CI).
 */
const ESCOPO = { p_org: 'c75eb92d-9222-49cc-ac0f-6aebaf8fa69f', p_conexao: 'bc55e20a-dd17-416c-9343-c511e3cd0b1b',
  p_executor: '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b' };
const TRABALHO = {
  caso: '11111111-1111-4111-8111-111111111111', conversa: '22222222-2222-4222-8222-222222222222',
  token: '33333333-3333-4333-8333-333333333333', run: '44444444-4444-4444-8444-444444444444',
  versao: 7, versao_global: 1, versao_org: 2, intencao: 'outro', resumo: null,
  mensagens: [{ conteudo: 'Meu pedido não chegou, quero falar com alguém', criadaEm: '2026-11-23T15:00:00Z' }],
};

type Resultado = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;
const saida = (valor: unknown): Resultado => ({
  content: [{ type: 'text', text: JSON.stringify(valor) }], finishReason: { unified: 'stop', raw: 'stop' },
  usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, warnings: [],
}) as unknown as Resultado;
const canal: CanalDeProjecaoAiFirst = { pronto: async () => true, ler: async () => { throw new Error('x'); }, alterarSemAtribuir: async () => undefined };

interface Cenario {
  readonly modelo: () => Promise<Resultado>;
  /** O que `concluir_geracao_ai_first` devolve a cada chamada (ou lança). */
  readonly conclusao: ReadonlyArray<string | Error>;
  readonly modo?: 'AI' | 'HUMAN_REQUIRED' | 'HUMAN' | Error | null;
}
function montar(c: Cenario) {
  const conclusoes: Array<Record<string, unknown>> = [];
  let i = 0;
  const banco = {
    async rpc(nome: string, args: Record<string, unknown>) {
      if (nome === 'renovar_worker_ai_first') return { data: true, error: null };
      if (nome === 'reivindicar_geracao_ai_first') return { data: TRABALHO, error: null };
      if (nome === 'concluir_geracao_ai_first') {
        conclusoes.push(args);
        const r = c.conclusao[Math.min(i++, c.conclusao.length - 1)];
        return r instanceof Error ? { data: null, error: r } : { data: r, error: null };
      }
      return { data: null, error: null };
    },
  };
  const mock = new MockLanguageModelV4({ doGenerate: c.modelo });
  const modelo = criarModeloHauxPorAiSdk(mock, 'groq', undefined, { conhecimento: CONHECIMENTO_PORTAL_DO_HAUX, catalogo: async () => [] });
  const modoDoAtendimento = async () => { if (c.modo instanceof Error) throw c.modo; return c.modo ?? null; };
  const passar = () => consumirAiFirstUmaVez({ escopo: ESCOPO, habilitado: true, modelo, canal, banco, modoDoAtendimento });
  const textosEnviados = () => conclusoes.map((a) => a.p_texto).filter((t) => t !== null);
  return { passar, conclusoes, textosEnviados };
}
const responde = (texto: string) => async () => saida({ acao: 'responder', texto });
const encaminha = async () => saida({ acao: 'encaminhar', texto: 'A equipe continua seu atendimento.' });

describe('promessa de transferência nunca sai com a conversa na automação (defeito da conversa 11)', () => {
  it('T1. "a equipe continua seu atendimento" vira transferência real: nenhum texto, transição confirmada', async () => {
    const w = montar({ modelo: responde('Entendi. A equipe continua seu atendimento por aqui.'), conclusao: ['escalonada'] });
    expect(await w.passar()).toMatchObject({ estado: 'processado', geracao: 'escalonada', transferencia: 'confirmada' });
    expect(w.textosEnviados()).toEqual([]);
    expect(w.conclusoes).toEqual([expect.objectContaining({ p_texto: null, p_token: TRABALHO.token, p_versao: 7 })]);
  });

  it('T2. decisão "encaminhar" do modelo atravessa adaptador, validação e worker sem ser descartada', async () => {
    const w = montar({ modelo: encaminha, conclusao: ['escalonada'] });
    expect(await w.passar()).toMatchObject({ transferencia: 'confirmada' });
    expect(w.textosEnviados()).toEqual([]);
  });

  it.each([
    'Vou te encaminhar para um atendente.', 'Já avisei a equipe, que vai te responder em breve.',
    'Em breve um atendente fala com você.', 'Passei seu caso para o time; alguém vai te atender.',
  ])('T3. promessa "%s" nunca é registrada como texto', async (promessa) => {
    const w = montar({ modelo: responde(promessa), conclusao: ['escalonada'] });
    await w.passar();
    expect(w.textosEnviados()).toEqual([]);
  });

  it('T4. oferta verdadeira de ajuda humana não é promessa e sai como resposta', async () => {
    const w = montar({ modelo: responde('Ainda não tenho essa informação. Se preferir falar com uma pessoa, é só pedir.'), conclusao: ['registrada'] });
    expect(await w.passar()).toMatchObject({ geracao: 'registrada' });
    expect(w.textosEnviados()).toEqual([expect.stringContaining('é só pedir')]);
  });
});

describe('falha, concorrência, ACK perdido e repetição da transferência', () => {
  it('T5. provedor de IA fora: transferência pelo mesmo caminho, sem texto', async () => {
    const w = montar({ modelo: async () => { throw new Error('503'); }, conclusao: ['escalonada'] });
    expect(await w.passar()).toMatchObject({ transferencia: 'confirmada' });
    expect(w.textosEnviados()).toEqual([]);
  });

  it('T6. atendente assumiu durante a geração (obsoleta, modo HUMAN): humano no controle, nada enviado', async () => {
    const w = montar({ modelo: encaminha, conclusao: ['obsoleta'], modo: 'HUMAN' });
    expect(await w.passar()).toMatchObject({ geracao: 'obsoleta', transferencia: 'humano_no_controle' });
    expect(w.textosEnviados()).toEqual([]);
  });

  it('T7. geração obsoleta com a conversa ainda na automação: não confirmada, sem promessa e sem nova tentativa nesta passada', async () => {
    const w = montar({ modelo: encaminha, conclusao: ['obsoleta'], modo: 'AI' });
    expect(await w.passar()).toMatchObject({ transferencia: 'nao_confirmada' });
    expect(w.conclusoes).toHaveLength(1);
  });

  it('T8. ACK perdido: a RPC falhou, mas o estado persistido já é HUMAN_REQUIRED: confirmada pelo banco, sem erro', async () => {
    const w = montar({ modelo: encaminha, conclusao: [new Error('timeout')], modo: 'HUMAN_REQUIRED' });
    expect(await w.passar()).toMatchObject({ transferencia: 'humano_no_controle' });
  });

  it('T9. RPC falhou e a conversa segue na automação: o erro propaga (worker fica não pronto) e nada é enviado', async () => {
    const w = montar({ modelo: encaminha, conclusao: [new Error('timeout')], modo: 'AI' });
    await expect(w.passar()).rejects.toThrow('concluir_geracao_ai_first');
    expect(w.textosEnviados()).toEqual([]);
  });

  it('T10. RPC e leitura do estado falharam: desconhecida, o erro propaga', async () => {
    const w = montar({ modelo: encaminha, conclusao: [new Error('rede')], modo: new Error('rede') });
    await expect(w.passar()).rejects.toThrow();
  });

  it('T11. repetição da mesma reivindicação: a segunda conclusão é obsoleta e só uma transferência é confirmada', async () => {
    const w = montar({ modelo: encaminha, conclusao: ['escalonada', 'obsoleta'], modo: 'HUMAN_REQUIRED' });
    const primeira = await w.passar();
    const segunda = await w.passar();
    expect([primeira, segunda].map((r) => 'transferencia' in r && r.transferencia)).toEqual(['confirmada', 'humano_no_controle']);
    expect(w.conclusoes.map((a) => a.p_token)).toEqual([TRABALHO.token, TRABALHO.token]);
    expect(w.textosEnviados()).toEqual([]);
  });
});
