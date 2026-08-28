import { describe, expect, it } from 'vitest';
import { LOGS_RETENTION_FUNDAMENTO, LogsAdapter, type AuditoriaEventoRow, type TitularLogsPort } from './logsAdapter';
import type { TitularTaskContext } from './types';

class FakeTitularLogsPort implements TitularLogsPort {
  eventos = new Map<string, AuditoriaEventoRow[]>();
  async findEventosPorAtor(_organizationId: string, actorId: string) {
    return this.eventos.get(actorId) ?? [];
  }
}

function contextFor(overrides: Partial<TitularTaskContext> = {}): TitularTaskContext {
  return {
    organizationId: 'org-1',
    titularTipo: 'lojista_user',
    titularRefUserId: 'user-1',
    titularRefClienteId: null,
    solicitacaoId: 'req-1',
    correlationId: 'corr-1',
    ...overrides,
  };
}

describe('LogsAdapter', () => {
  it('never deletes/corrects the audit trail — always retained_with_reason', async () => {
    const adapter = new LogsAdapter(new FakeTitularLogsPort());
    const exclusao = await adapter.execute('exclusao', contextFor());
    const correcao = await adapter.execute('correcao', contextFor());
    expect(exclusao).toEqual({ status: 'retained_with_reason', fundamento: LOGS_RETENTION_FUNDAMENTO });
    expect(correcao).toEqual({ status: 'retained_with_reason', fundamento: LOGS_RETENTION_FUNDAMENTO });
  });

  it('returns not_found when there is no audit trail for the titular', async () => {
    const adapter = new LogsAdapter(new FakeTitularLogsPort());
    const outcome = await adapter.execute('acesso', contextFor());
    expect(outcome).toEqual({ status: 'not_found' });
  });

  it('exports audit events on acesso/exportacao, without internal metadata (ip/user_agent/metadata)', async () => {
    const port = new FakeTitularLogsPort();
    port.eventos.set('user-1', [
      { id: 'evt-1', acao: 'login', recurso: 'sessao', recurso_id: null, created_at: '2026-01-01T00:00:00Z' },
    ]);
    const adapter = new LogsAdapter(port);
    const outcome = await adapter.execute('exportacao', contextFor());
    expect(outcome).toEqual({
      status: 'completed',
      data: { eventos: [{ acao: 'login', recurso: 'sessao', recurso_id: null, data: '2026-01-01T00:00:00Z' }] },
    });
  });
});
