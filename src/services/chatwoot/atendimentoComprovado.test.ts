import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { atendidaAteEntre, consumirAiFirstUmaVez, type CanalDeProjecaoAiFirst } from './workerAiFirst';
import { lerUltimaRespostaDaConversa } from './espelhoChatwootSupabase';
import { lerUltimoEnvioConfirmadoDaConversa } from './envioChatwoot';
import { lerUltimaDevolucaoDaConversa } from './controleAtendimento';
import type { ModeloDeResposta } from '../sac/gerarResposta';

/**
 * Regressão: resposta registrada não é resposta entregue. O worker usa os
 * leitores reais sobre um PostgREST em memória (aplica eq/is/order/limit) e
 * a verificação olha a solicitação que chega ao modelo.
 */
const ORG = 'c75eb92d-9222-49cc-ac0f-6aebaf8fa69f';
const CONEXAO = 'bc55e20a-dd17-416c-9343-c511e3cd0b1b';
const OUTRA_ORG = 'a0000000-0000-4000-8000-00000000000a';
const ESCOPO = { p_org: ORG, p_conexao: CONEXAO, p_executor: '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b' };
const CONVERSA = '22222222-2222-4222-8222-222222222222';
const OUTRA_CONVERSA = '55555555-5555-4555-8555-555555555555';
const em = (s: number) => new Date(Date.UTC(2026, 10, 23, 15, 0, s)).toISOString();

const TRABALHO = {
  caso: '11111111-1111-4111-8111-111111111111', conversa: CONVERSA, token: '33333333-3333-4333-8333-333333333333',
  run: '44444444-4444-4444-8444-444444444444', versao: 7, versao_global: 1, versao_org: 2,
  intencao: 'duvida_sobre_produto', resumo: null,
  // X aos 0 s; a resposta a X foi registrada aos 10 s; Y aos 40 s.
  mensagens: [{ conteudo: 'Quanto custa o kuripe?', criadaEm: em(0) }, { conteudo: 'E o defumador?', criadaEm: em(40) }],
};

type Linha = Record<string, unknown>;
/** PostgREST mínimo em memória: filtra por igualdade e nulo, ordena e limita como a consulta pede. */
function postgrestEmMemoria(tabelas: Record<string, Linha[]>): SupabaseClient {
  const from = (tabela: string) => {
    let linhas = [...(tabelas[tabela] ?? [])];
    const q = {
      select: () => q,
      eq: (coluna: string, valor: unknown) => { linhas = linhas.filter((l) => l[coluna] === valor); return q; },
      is: (coluna: string, valor: null) => { linhas = linhas.filter((l) => (l[coluna] ?? null) === valor); return q; },
      order: (coluna: string, { ascending }: { ascending: boolean }) => {
        linhas.sort((a, b) => String(a[coluna]).localeCompare(String(b[coluna])) * (ascending ? 1 : -1)); return q;
      },
      limit: (n: number) => Promise.resolve({ data: linhas.slice(0, n), error: null }),
    };
    return q;
  };
  return { from } as unknown as SupabaseClient;
}

const envio = (segundos: number, status: string, extra: Linha = {}): Linha => ({
  organizacao_id: ORG, conexao_id: CONEXAO, conversa_id_local: CONVERSA, privada: false,
  created_at: em(segundos), invalidado_em: null, outbox_eventos: { status }, ...extra,
});

async function solicitacaoNoModelo(tabelas: Record<string, Linha[]>) {
  const banco = postgrestEmMemoria(tabelas);
  const daConexao = { organizacaoId: ORG, conexaoId: CONEXAO };
  const atendidaAte = atendidaAteEntre(
    (_e, c) => lerUltimaRespostaDaConversa(banco, daConexao, c),
    (_e, c) => lerUltimoEnvioConfirmadoDaConversa(banco, daConexao, c),
    (e, c) => lerUltimaDevolucaoDaConversa(banco, e.p_org, c));
  const conclusoes: Record<string, unknown>[] = [];
  const rpc = {
    async rpc(nome: string, args: Record<string, unknown>) {
      if (nome === 'renovar_worker_ai_first') return { data: true, error: null };
      if (nome === 'reivindicar_geracao_ai_first') return { data: TRABALHO, error: null };
      if (nome === 'concluir_geracao_ai_first') { conclusoes.push(args); return { data: 'registrada', error: null }; }
      return { data: null, error: null };
    },
  };
  const canal: CanalDeProjecaoAiFirst = { pronto: async () => true, ler: async () => { throw new Error('x'); }, alterarSemAtribuir: async () => undefined };
  const entradas: string[] = [];
  const modelo: ModeloDeResposta = { provedor: 'fake', async gerar(_i, entrada) { entradas.push(entrada); return { texto: 'ok' }; } };
  await consumirAiFirstUmaVez({ escopo: ESCOPO, habilitado: true, modelo, canal, banco: rpc, atendidaAte });
  expect(entradas).toHaveLength(1);
  // Idempotência e fencing intactos: uma conclusão, com o token e as versões da reivindicação.
  expect(conclusoes).toEqual([expect.objectContaining({ p_token: TRABALHO.token, p_versao: 7, p_global: 1, p_org_versao: 2 })]);
  const atual = entradas[0].match(/<solicitacao_atual>([\s\S]*?)<\/solicitacao_atual>/u)?.[1] ?? '';
  return [...atual.matchAll(/<mensagem ordem="\d+">([\s\S]*?)<\/mensagem>/gu)].map((m) => m[1]);
}

const AMBAS = ['Quanto custa o kuripe?', 'E o defumador?'];
const SO_Y = ['E o defumador?'];

describe('resposta registrada × entregue × desconhecida: só a entregue encerra a pergunta', () => {
  it.each([
    ['pendente por atraso do worker', 'pending'],
    ['em processamento', 'processing'],
    ['falhou antes do envio e aguarda nova tentativa', 'failed_transient'],
    ['despachada sem recibo ainda', 'in_flight'],
    ['em dead_letter sem invalidado_em', 'dead_letter'],
    ['de resultado desconhecido (sem confirmação de entrega)', 'unknown'],
  ])('resposta a X %s: X continua na solicitação atual', async (_caso, status) => {
    expect(await solicitacaoNoModelo({ chatwoot_envios: [envio(10, status)] })).toEqual(AMBAS);
  });

  it('resposta a X confirmada pela outbox (sent): X vira histórico, antes mesmo de aparecer no espelho', async () => {
    expect(await solicitacaoNoModelo({ chatwoot_envios: [envio(10, 'sent')] })).toEqual(SO_Y);
  });

  it('confirmada mas invalidada por mudança de responsável: não saiu, X continua pedido', async () => {
    expect(await solicitacaoNoModelo({ chatwoot_envios: [envio(10, 'sent', { invalidado_em: em(12) })] })).toEqual(AMBAS);
  });

  it('desconhecida na outbox, mas presente no Chatwoot: o espelho prova a entrega', async () => {
    const espelho = { organizacao_id: ORG, conexao_id: CONEXAO, conversa_id_local: CONVERSA, message_type: 'outgoing', created_at: em(15) };
    expect(await solicitacaoNoModelo({ chatwoot_envios: [envio(10, 'unknown')], chatwoot_messages: [espelho] })).toEqual(SO_Y);
  });

  it('confirmada mais antiga atrás de uma morta: o corte para na confirmada, e a pergunta da morta continua pedido', async () => {
    // Confirmada aos −5 s (antes de X) e a resposta a X morta aos 10 s.
    expect(await solicitacaoNoModelo({ chatwoot_envios: [envio(10, 'dead_letter'), envio(-5, 'sent')] })).toEqual(AMBAS);
  });

  it('nota privada, outra conversa e outra organização não provam atendimento desta conversa', async () => {
    expect(await solicitacaoNoModelo({ chatwoot_envios: [
      envio(10, 'sent', { privada: true }),
      envio(10, 'sent', { conversa_id_local: OUTRA_CONVERSA }),
      envio(10, 'sent', { organizacao_id: OUTRA_ORG }),
    ] })).toEqual(AMBAS);
  });

  it('devolução do atendente encerra o que veio antes; iniciar_ia não', async () => {
    const devolver = { organizacao_id: ORG, conversa_id_local: CONVERSA, acao: 'devolver', created_at: em(20) };
    expect(await solicitacaoNoModelo({ chatwoot_controle_historico: [devolver] })).toEqual(SO_Y);
    expect(await solicitacaoNoModelo({ chatwoot_controle_historico: [{ ...devolver, acao: 'iniciar_ia' }] })).toEqual(AMBAS);
  });
});
