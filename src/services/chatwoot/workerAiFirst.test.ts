import { describe, expect, it } from 'vitest';
import { consumirAiFirstUmaVez, atendidaAteEntre, type CanalDeProjecaoAiFirst, type LerAtendidaAte } from './workerAiFirst';
import type { ModeloDeResposta } from '../sac/gerarResposta';

const ESCOPO = { p_org: 'c75eb92d-9222-49cc-ac0f-6aebaf8fa69f', p_conexao: 'bc55e20a-dd17-416c-9343-c511e3cd0b1b',
  p_executor: '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b' };
const TRABALHO = {
  caso: '11111111-1111-4111-8111-111111111111', conversa: '22222222-2222-4222-8222-222222222222',
  token: '33333333-3333-4333-8333-333333333333', run: '44444444-4444-4444-8444-444444444444',
  versao: 7, versao_global: 1, versao_org: 2, intencao: 'duvida_sobre_produto', resumo: null,
  mensagens: [
    { conteudo: 'Quanto custa o defumador?', criadaEm: '2026-11-23T15:00:00Z' },
    { conteudo: 'E kuripe?', criadaEm: '2026-11-23T15:00:40Z' },
  ],
};

const canal: CanalDeProjecaoAiFirst = {
  async pronto() { return true; },
  async ler() { throw new Error('sem projeção neste teste'); },
  async alterarSemAtribuir() { throw new Error('sem projeção neste teste'); },
};

function montar(atendida?: LerAtendidaAte) {
  const rpcs: Array<[string, Record<string, unknown>]> = [];
  const banco = {
    async rpc(nome: string, args: Record<string, unknown>) {
      rpcs.push([nome, args]);
      if (nome === 'renovar_worker_ai_first') return { data: true, error: null };
      if (nome === 'reivindicar_geracao_ai_first') return { data: TRABALHO, error: null };
      if (nome === 'concluir_geracao_ai_first') return { data: 'registrada', error: null };
      return { data: null, error: null };
    },
  };
  const entradas: string[] = [];
  const modelo: ModeloDeResposta = { provedor: 'fake', async gerar(_i, entrada) { entradas.push(entrada); return { texto: 'Temos kuripes.' }; } };
  const leituras: Array<[unknown, string]> = [];
  const leitor: LerAtendidaAte | undefined = atendida && (async (escopo, conversa) => {
    leituras.push([escopo, conversa]);
    return atendida(escopo, conversa);
  });
  const passar = () => consumirAiFirstUmaVez({ escopo: ESCOPO, habilitado: true, modelo, canal, banco, atendidaAte: leitor });
  return { passar, rpcs, entradas, leituras };
}

describe('worker AI-first: corte do que já foi respondido', () => {
  it('lê a última resposta da conversa reivindicada, no escopo do worker, e só a mensagem nova vira pedido', async () => {
    const w = montar(async () => '2026-11-23T15:00:20Z');
    expect(await w.passar()).toMatchObject({ estado: 'processado', geracao: 'registrada' });
    expect(w.leituras).toEqual([[ESCOPO, TRABALHO.conversa]]);
    expect(w.entradas).toHaveLength(1);
    expect(w.entradas[0]).toMatch(/<historico_contextual>\n<mensagem ordem="1">Quanto custa o defumador\?<\/mensagem>\n<\/historico_contextual>/u);
    expect(w.entradas[0]).toMatch(/<solicitacao_atual>\n<mensagem ordem="2">E kuripe\?<\/mensagem>\n<\/solicitacao_atual>/u);
    const conclusao = w.rpcs.find(([nome]) => nome === 'concluir_geracao_ai_first')?.[1];
    expect(conclusao).toMatchObject({ p_token: TRABALHO.token, p_versao: 7, p_texto: 'Temos kuripes.' });
  });

  it('falha na leitura não bloqueia a resposta e não torna o histórico pedido', async () => {
    const w = montar(async () => { throw new Error('rede'); });
    expect(await w.passar()).toMatchObject({ estado: 'processado' });
    expect(w.entradas[0]).toContain('<solicitacao_atual>\n<mensagem ordem="2">E kuripe?</mensagem>');
  });

  it('sem leitor configurado, mesmo corte conservador', async () => {
    const w = montar();
    await w.passar();
    expect(w.entradas[0]).toContain('<historico_contextual>');
    expect(w.entradas[0]).toContain('<solicitacao_atual>\n<mensagem ordem="2">');
  });
});

describe('corte entre espelho e envio registrado', () => {
  it('vale o mais recente: a resposta registrada ainda não espelhada já atende a mensagem anterior', async () => {
    const espelho: LerAtendidaAte = async () => '2026-11-23T15:00:04.000Z';
    const envio: LerAtendidaAte = async () => '2026-11-23T15:00:28.823+00:00';
    await expect(atendidaAteEntre(espelho, envio)(ESCOPO, TRABALHO.conversa)).resolves.toBe('2026-11-23T15:00:28.823+00:00');
    await expect(atendidaAteEntre(async () => null, async () => null)(ESCOPO, TRABALHO.conversa)).resolves.toBeNull();
  });

  it('falha em qualquer fonte rejeita, e o worker cai no corte conservador', async () => {
    const corte = atendidaAteEntre(async () => '2026-11-23T15:00:04.000Z', async () => { throw new Error('rede'); });
    await expect(corte(ESCOPO, TRABALHO.conversa)).rejects.toThrow('rede');
    const w = montar(corte);
    await w.passar();
    expect(w.entradas[0]).toMatch(/<solicitacao_atual>\n<mensagem ordem="2">E kuripe\?<\/mensagem>/u);
  });
});
