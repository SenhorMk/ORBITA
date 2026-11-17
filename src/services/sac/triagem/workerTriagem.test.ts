import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { consumirTriagensUmaVez, PERSISTENCIA_POR_ITEM_MS, type PortaDoConsumidorTriagem } from './consumidorTriagem';
import { criarPortaDoConsumidorTriagem, FilaDeTriagemIndisponivel } from './consumidorTriagemSupabase';
import type { ModeloDeTriagem } from './triagemDoCaso';
import { lerConfiguracaoDoWorkerTriagem } from './workerTriagem';

const CHAVE = 'chave-sintetica-de-teste-000000';

describe('lerConfiguracaoDoWorkerTriagem', () => {
  it('sem nada: desligado, limite diário 0', () => {
    expect(lerConfiguracaoDoWorkerTriagem({})).toMatchObject({ ligado: false, modelo: null, limiteDiario: 0 });
  });

  it('ligado sem provedor, ou Google sem chave ou modelo: recusa subir', () => {
    expect(() => lerConfiguracaoDoWorkerTriagem({ SAC_TRIAGEM_WORKER_ENABLED: 'true' })).toThrow(/SAC_TRIAGEM_PROVEDOR/u);
    expect(() => lerConfiguracaoDoWorkerTriagem({ SAC_TRIAGEM_WORKER_ENABLED: 'true', SAC_TRIAGEM_PROVEDOR: 'google', SAC_TRIAGEM_MODELO: 'gemini-2.5-flash' }))
      .toThrow(/GOOGLE_GENERATIVE_AI_API_KEY/u);
  });

  it('modelo fora da lista aprovada: recusa subir, sem ecoar a chave', () => {
    let mensagem = '';
    try {
      lerConfiguracaoDoWorkerTriagem({
        SAC_TRIAGEM_WORKER_ENABLED: 'true', SAC_TRIAGEM_PROVEDOR: 'google', SAC_TRIAGEM_MODELO: 'gemini-2.5-pro', GOOGLE_GENERATIVE_AI_API_KEY: CHAVE,
      });
    } catch (erro: unknown) {
      mensagem = (erro as Error).message;
    }
    expect(mensagem).toMatch(/SAC_TRIAGEM_MODELO/u);
    expect(mensagem).not.toContain(CHAVE);
  });

  it('Google configurado: modelo identificado; lease cobre duas chamadas com timeout', () => {
    const c = lerConfiguracaoDoWorkerTriagem({
      SAC_TRIAGEM_WORKER_ENABLED: 'true', SAC_TRIAGEM_PROVEDOR: 'google', SAC_TRIAGEM_MODELO: 'gemini-2.5-flash',
      GOOGLE_GENERATIVE_AI_API_KEY: CHAVE, SAC_TRIAGEM_LIMITE_DIARIO_POR_ORGANIZACAO: '200', SAC_TRIAGEM_TIMEOUT_MS: '60000', SAC_TRIAGEM_LEASE_SECONDS: '30',
    });
    expect(c.modelo).toMatchObject({ provedor: 'google', modelo: 'gemini-2.5-flash' });
    expect(c.limiteDiario).toBe(200);
    expect(c.leaseSegundos).toBeGreaterThanOrEqual(135);
  });

  it('o lote padrão é o que cabe na lease de 120 s com timeout de 20 s', () => {
    expect(lerConfiguracaoDoWorkerTriagem({})).toMatchObject({ lote: 2, leaseSegundos: 120, timeoutMs: 20_000 });
  });

  it('falso: declarado como fake', () => {
    expect(lerConfiguracaoDoWorkerTriagem({ SAC_TRIAGEM_WORKER_ENABLED: 'true', SAC_TRIAGEM_PROVEDOR: 'fake' }).modelo?.provedor).toBe('fake');
  });
});

/**
 * Relógio virtual no pior caso: toda chamada ao modelo gasta o timeout inteiro (fora do schema e
 * depois timeout, as duas chamadas permitidas) e cada ida ao banco gasta metade da persistência
 * reservada. A lease conta do começo do pedido de reivindicação, o instante mais cedo possível.
 */
function passadaNoPiorCaso(configuracao: ReturnType<typeof lerConfiguracaoDoWorkerTriagem>, atrasoDoInicio: (i: number) => number = () => 0) {
  let agora = 0;
  let inicioDaLease = Number.NaN;
  let iniciados = 0;
  let chamadas = 0;
  const conclusoes: number[] = [];
  const meiaPersistencia = PERSISTENCIA_POR_ITEM_MS / 2;
  const porta: PortaDoConsumidorTriagem = {
    liberarLeasesVencidas: async () => 0,
    reivindicar: async ({ limite }) => {
      inicioDaLease = agora;
      agora += 200;
      return Array.from({ length: limite }, (_, i) => ({ ...ITEM, eventoId: `evento-${i}` }));
    },
    iniciar: async () => {
      agora += meiaPersistencia + atrasoDoInicio(iniciados);
      iniciados += 1;
      return { _tag: 'Iniciada', runId: 'run', mensagens: [{ conteudo: 'Quero trocar o tamanho', criadaEm: '2026-11-17T10:00:00Z' }] };
    },
    concluir: async () => {
      agora += meiaPersistencia;
      conclusoes.push(agora);
      return 'falha';
    },
  };
  const modelo: ModeloDeTriagem = {
    provedor: 'teste',
    modelo: 'm',
    gerar: async () => {
      agora += configuracao.timeoutMs;
      chamadas += 1;
      return chamadas % 2 === 1 ? { _tag: 'Invalido', uso: { entrada: null, saida: null } } : { _tag: 'Timeout' };
    },
  };
  return {
    executar: () => consumirTriagensUmaVez(porta, modelo, {
      workerId: 'w', limite: configuracao.lote, leaseSegundos: configuracao.leaseSegundos, limiteDiario: 10,
      timeoutMs: configuracao.timeoutMs, relogio: () => agora,
    }),
    fim: () => ({ fimDaLease: inicioDaLease + configuracao.leaseSegundos * 1000, iniciados, conclusoes }),
  };
}

describe('o worker não reivindica mais triagens do que conclui dentro da lease (auditoria 17/11, R2)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('em toda configuração válida, o lote inteiro conclui antes de a lease vencer', async () => {
    // Antes: lease 55 s, timeout 1 s e lote 20 davam lote 20 (40 s só de modelo) sem tempo para o banco.
    for (const lease of [30, 45, 55, 60, 95, 120, 300, 600]) {
      for (const timeout of [1_000, 5_000, 20_000, 60_000]) {
        for (const lote of [1, 5, 20]) {
          const configuracao = lerConfiguracaoDoWorkerTriagem({
            SAC_TRIAGEM_LEASE_SECONDS: String(lease), SAC_TRIAGEM_TIMEOUT_MS: String(timeout), SAC_TRIAGEM_BATCH: String(lote),
          });
          const passada = passadaNoPiorCaso(configuracao);
          await passada.executar();
          const { fimDaLease, iniciados, conclusoes } = passada.fim();
          const caso = `lease ${lease}, timeout ${timeout}, lote ${lote} → lote ${configuracao.lote}, lease ${configuracao.leaseSegundos}`;
          expect(configuracao.leaseSegundos, caso).toBeLessThanOrEqual(600);
          expect(iniciados, caso).toBe(configuracao.lote);
          expect(conclusoes, caso).toHaveLength(configuracao.lote);
          expect(Math.max(...conclusoes), caso).toBeLessThanOrEqual(fimDaLease);
        }
      }
    }
  });

  it('banco lento no meio do lote: o item que não cabe mais na lease nem começa', async () => {
    const configuracao = lerConfiguracaoDoWorkerTriagem({});
    // O primeiro início espera 40 s numa trava: o segundo item terminaria depois da lease.
    const passada = passadaNoPiorCaso(configuracao, (i) => (i === 0 ? 40_000 : 0));
    await passada.executar();
    const { fimDaLease, iniciados, conclusoes } = passada.fim();
    expect(iniciados).toBe(1);
    expect(Math.max(...conclusoes)).toBeLessThanOrEqual(fimDaLease);
  });
});

type Resposta = { data: unknown; error: { code: string } | null };

function banco(respostas: Record<string, Resposta>) {
  const chamadas: Array<{ funcao: string; parametros: Record<string, unknown> }> = [];
  const cliente = {
    rpc(funcao: string, parametros: Record<string, unknown>) {
      chamadas.push({ funcao, parametros });
      return Promise.resolve(respostas[funcao] ?? { data: null, error: { code: 'PGRST202' } });
    },
  } as unknown as SupabaseClient;
  return { cliente, chamadas };
}

const ITEM = {
  eventoId: '11111111-1111-4111-8111-111111111111', organizacaoId: '22222222-2222-4222-8222-222222222222',
  casoId: '33333333-3333-4333-8333-333333333333', correlationId: null, fencingToken: 3,
};
const PEDIDO = { workerId: 'w', limiteDiario: 10, provedor: 'google', modelo: 'gemini-2.5-flash', versaoPrompt: 'triagem-v1', versaoSchema: 1 };

describe('criarPortaDoConsumidorTriagem', () => {
  it('iniciar: passa token, limite e versões; devolve as mensagens', async () => {
    const { cliente, chamadas } = banco({ iniciar_triagem_sac: { data: {
      resultado: 'iniciada', run_id: '44444444-4444-4444-8444-444444444444', mensagens: [{ conteudo: 'oi', criada_em: '2026-11-12T10:00:00Z' }],
    }, error: null } });
    const inicio = await criarPortaDoConsumidorTriagem(cliente).iniciar(ITEM, PEDIDO);
    expect(inicio).toEqual({ _tag: 'Iniciada', runId: '44444444-4444-4444-8444-444444444444', mensagens: [{ conteudo: 'oi', criadaEm: '2026-11-12T10:00:00Z' }] });
    expect(chamadas[0].parametros).toMatchObject({ p_evento_id: ITEM.eventoId, p_fencing_token: 3, p_limite_diario: 10, p_versao_schema: 1 });
  });

  it('encerramentos do banco viram resultado tipado', async () => {
    for (const resultado of ['obsoleta', 'sem_orcamento', 'caso_inexistente', 'posse_perdida'] as const) {
      const { cliente } = banco({ iniciar_triagem_sac: { data: { resultado }, error: null } });
      expect(await criarPortaDoConsumidorTriagem(cliente).iniciar(ITEM, PEDIDO)).toEqual({ _tag: 'Encerrada', motivo: resultado });
    }
  });

  it('erro ou resposta fora do contrato: fila indisponível, nunca triagem', async () => {
    const comErro = banco({ iniciar_triagem_sac: { data: null, error: { code: '57014' } } });
    await expect(criarPortaDoConsumidorTriagem(comErro.cliente).iniciar(ITEM, PEDIDO)).rejects.toBeInstanceOf(FilaDeTriagemIndisponivel);
    const torto = banco({ concluir_triagem_sac: { data: 'feito', error: null } });
    await expect(criarPortaDoConsumidorTriagem(torto.cliente).concluir('r', 'w', 1, {
      status: 'concluida', motivo: null, triagem: null, chamouModelo: true, tokensEntrada: 1, tokensSaida: 1, reparos: 0, latenciaMs: 1, repetirEmSegundos: 30,
    })).rejects.toBeInstanceOf(FilaDeTriagemIndisponivel);
  });
});
