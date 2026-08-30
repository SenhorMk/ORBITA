import { describe, expect, it } from 'vitest';

import {
  descreverProgresso,
  jobEmAndamento,
  syncEnqueueResponseSchema,
  syncStatusResponseSchema,
} from './syncContract';

/**
 * A fronteira que estes testes fecham é a mesma dos Tickets 27 e 28: o Ticket
 * 12 trocou a sincronização inline por job durável, a rota passou a responder
 * `202 { jobId, status }`, e o cliente continuou lendo `result.stats.pedidos`.
 * O acesso estourava `TypeError` e o `catch` genérico exibia "Erro ao comunicar
 * com o servidor" — para uma sincronização que tinha sido aceita.
 */
describe('resposta de POST /api/sync', () => {
  it('aceita a forma real: jobId e status, sem stats', () => {
    const resposta = { success: true, jobId: 'job-1', status: 'queued' };

    expect(syncEnqueueResponseSchema.safeParse(resposta).success).toBe(true);
  });

  it('recusa a forma antiga com stats, que a rota nunca devolveu depois do Ticket 12', () => {
    const antiga = { success: true, stats: { pedidos: 3, produtos: 2, clientes: 1 } };

    expect(syncEnqueueResponseSchema.safeParse(antiga).success).toBe(false);
  });

  it('recusa status fora dos estados conhecidos do job', () => {
    expect(syncEnqueueResponseSchema.safeParse({ success: true, jobId: 'j', status: 'sincronizado' }).success).toBe(false);
  });
});

describe('estados do job', () => {
  it('queued e running ainda avançam', () => {
    expect(jobEmAndamento('queued')).toBe(true);
    expect(jobEmAndamento('running')).toBe(true);
  });

  it('completed, failed e cancelled são finais', () => {
    expect(jobEmAndamento('completed')).toBe(false);
    expect(jobEmAndamento('failed')).toBe(false);
    expect(jobEmAndamento('cancelled')).toBe(false);
  });
});

describe('descrição do progresso', () => {
  const base = { id: 'job-1', last_error: null, completed_at: null };

  it('usa os números que o servidor reporta, sem inventar', () => {
    const texto = descreverProgresso({
      ...base,
      status: 'running',
      progress: { clientes_processados: 12, etapa_atual: 'clientes' },
    });

    expect(texto).toContain('12 clientes');
    expect(texto).toContain('clientes');
    expect(texto).not.toContain('undefined');
  });

  it('não inventa zero para etapa que ainda não começou', () => {
    const texto = descreverProgresso({ ...base, status: 'running', progress: { etapa_atual: 'clientes' } });

    expect(texto).not.toContain('0 produtos');
    expect(texto).toContain('em andamento');
  });

  it('mostra o erro real quando o job falha', () => {
    const texto = descreverProgresso({
      ...base,
      status: 'failed',
      last_error: 'Bling nao conectado para esta organizacao',
      progress: {},
    });

    expect(texto).toContain('Bling nao conectado');
  });

  it('não mascara falha sem detalhe como sucesso', () => {
    const texto = descreverProgresso({ ...base, status: 'failed', progress: {} });

    expect(texto).toContain('falhou');
    expect(texto).not.toContain('Sincronizado');
  });

  it('resume os totais ao concluir', () => {
    const texto = descreverProgresso({
      ...base,
      status: 'completed',
      completed_at: '2026-08-29T12:00:00.000Z',
      progress: { clientes_processados: 5, produtos_processados: 9, pedidos_processados: 2 },
    });

    expect(texto).toContain('Sincronizado!');
    expect(texto).toContain('5 clientes');
    expect(texto).toContain('9 produtos');
    expect(texto).toContain('2 pedidos');
  });
});

describe('resposta de GET /api/sync/status', () => {
  it('aceita a forma que a rota devolve', () => {
    const resposta = {
      success: true,
      job: {
        id: 'job-1',
        status: 'running',
        progress: { clientes_processados: 3, etapa_atual: 'clientes', pagina_atual: 1 },
        last_error: null,
        completed_at: null,
      },
    };

    expect(syncStatusResponseSchema.safeParse(resposta).success).toBe(true);
  });

  it('exige last_error e completed_at explicitamente nulos, não ausentes', () => {
    const semCampos = { success: true, job: { id: 'j', status: 'running', progress: {} } };

    expect(syncStatusResponseSchema.safeParse(semCampos).success).toBe(false);
  });
});
