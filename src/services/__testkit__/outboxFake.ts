import type { SupabaseClient } from '@supabase/supabase-js';

import type { DesfechoDoDespacho } from '@/services/outbox/desfechoDoEfeito';
import type { OutboxWorkerDeps } from '@/services/outbox/outboxWorker';
import type { ClaimedOutboxEvent, OutboxStatus } from '@/services/outboxService';

/**
 * A outbox em memória com as regras da migration 86 que o worker depende:
 * claim só de `pending`/`failed_transient` devido, fencing token que sobe a
 * cada claim, `in_flight` antes da rede, conclusão por compare-and-set de
 * dono + token + lease, reaper que leva `in_flight` vencido a `unknown`, e
 * `unknown` que só sai por reconciliação ou replay depois de provada a não
 * aplicação. A prova contra o banco real é o pgTAP
 * `supabase/tests/final/efeito_ambiguo_na_outbox.test.sql`; aqui o fake
 * serve à matriz de falhas do worker e do adapter.
 */

export interface LinhaFake {
  id: string;
  organizacaoId: string;
  status: OutboxStatus;
  attempts: number;
  maxAttempts: number;
  nextRetryAt: number;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  fencingToken: number;
  reciboRef: string | null;
  motivoBloqueio: string | null;
  resolucao: string | null;
  tentativas: Array<{ token: number; desfecho: string; motivo: string | null }>;
}

interface Estado {
  readonly linhas: Map<string, LinhaFake>;
  agora: () => number;
}

type OutboxFake = NonNullable<OutboxWorkerDeps['outbox']>;

function emPosse(estado: Estado, linha: LinhaFake, worker: string, token: number): boolean {
  return linha.leaseOwner === worker && linha.fencingToken === token
    && linha.leaseExpiresAt !== null && linha.leaseExpiresAt >= estado.agora();
}

function liberarLease(linha: LinhaFake): void {
  linha.leaseOwner = null;
  linha.leaseExpiresAt = null;
}

function reaper(estado: Estado): OutboxFake['releaseExpiredLeases'] {
  return async () => {
    const liberados: Array<{ eventoId: string; novoStatus: OutboxStatus }> = [];
    for (const linha of estado.linhas.values()) {
      const vencida = linha.leaseExpiresAt !== null && linha.leaseExpiresAt < estado.agora();
      if ((linha.status !== 'processing' && linha.status !== 'in_flight') || !vencida) continue;
      linha.attempts += 1;
      if (linha.status === 'in_flight') {
        linha.status = 'unknown';
        linha.motivoBloqueio = 'lease_expirada_em_voo';
        const t = linha.tentativas.find((x) => x.token === linha.fencingToken && x.desfecho === 'em_voo');
        if (t) Object.assign(t, { desfecho: 'desconhecido', motivo: 'lease_expirada_em_voo' });
      } else {
        linha.status = linha.attempts >= linha.maxAttempts ? 'dead_letter' : 'failed_transient';
        linha.nextRetryAt = estado.agora();
      }
      liberarLease(linha);
      liberados.push({ eventoId: linha.id, novoStatus: linha.status });
    }
    return liberados;
  };
}

function reivindicar(estado: Estado): OutboxFake['claimBatch'] {
  return async (_supabase, workerId, limit = 20, leaseTtlSeconds = 300) => {
    const lote: ClaimedOutboxEvent[] = [];
    for (const linha of estado.linhas.values()) {
      if (lote.length >= limit) break;
      if ((linha.status !== 'pending' && linha.status !== 'failed_transient') || linha.nextRetryAt > estado.agora()) continue;
      linha.status = 'processing';
      linha.fencingToken += 1;
      linha.leaseOwner = workerId;
      linha.leaseExpiresAt = estado.agora() + leaseTtlSeconds * 1000;
      lote.push({
        evento_id: linha.id, organizacao_id: linha.organizacaoId, conexao_id: null,
        destination: 'chatwoot', event_type: 'message.send', payload: { content: 'oi' },
        attempts: linha.attempts, max_attempts: linha.maxAttempts, lease_owner: workerId,
        lease_expires_at: new Date(linha.leaseExpiresAt).toISOString(), correlation_id: null,
        fencing_token: linha.fencingToken,
      });
    }
    return lote;
  };
}

function aplicarDesfecho(estado: Estado, linha: LinhaFake, desfecho: DesfechoDoDespacho): void {
  linha.attempts += 1;
  if (desfecho._tag === 'Confirmado') {
    linha.status = 'sent';
    linha.reciboRef = desfecho.recibo;
  } else if (desfecho._tag === 'Desconhecido') {
    linha.status = 'unknown';
    linha.motivoBloqueio = desfecho.motivo;
  } else if (desfecho._tag === 'Recusado' || linha.attempts >= linha.maxAttempts) {
    linha.status = 'dead_letter';
  } else {
    linha.status = 'failed_transient';
    linha.nextRetryAt = estado.agora() + (desfecho.retryAfterSeconds ?? 10) * 1000;
  }
}

function concluir(estado: Estado): OutboxFake['concludeAttempt'] {
  return async (_supabase, posse, desfecho) => {
    const linha = estado.linhas.get(posse.eventoId);
    const emCurso = linha && (linha.status === 'processing' || linha.status === 'in_flight');
    if (!linha || !emCurso || !emPosse(estado, linha, posse.workerId, posse.fencingToken)) return null;
    if (linha.status === 'processing' && (desfecho._tag === 'Confirmado' || desfecho._tag === 'Desconhecido')) {
      throw new Error('22023: sem despacho iniciado');
    }
    aplicarDesfecho(estado, linha, desfecho);
    const t = linha.tentativas.find((x) => x.token === posse.fencingToken);
    if (t) Object.assign(t, { desfecho: desfecho._tag, motivo: desfecho._tag === 'Desconhecido' ? desfecho.motivo : null });
    liberarLease(linha);
    return linha.status;
  };
}

function portaFake(estado: Estado): OutboxFake {
  return {
    releaseExpiredLeases: reaper(estado),
    claimBatch: reivindicar(estado),
    async startDispatch(_supabase, eventoId, workerId, token) {
      const linha = estado.linhas.get(eventoId);
      if (!linha || linha.status !== 'processing' || !emPosse(estado, linha, workerId, token)) return false;
      linha.status = 'in_flight';
      linha.tentativas.push({ token, desfecho: 'em_voo', motivo: null });
      return true;
    },
    concludeAttempt: concluir(estado),
  };
}

/** Reconciliação: só `unknown`; confirmar exige a referência exata. */
function reconciliar(estado: Estado) {
  return (id: string, resolucao: 'confirmado' | 'provado_nao_aplicado' | 'revisao_manual', recibo?: string): OutboxStatus => {
    const linha = estado.linhas.get(id);
    if (!linha || linha.status !== 'unknown') throw new Error('55000');
    if (resolucao === 'confirmado') {
      if (!recibo) throw new Error('22023');
      linha.status = 'sent';
      linha.reciboRef = recibo;
      return 'sent';
    }
    linha.resolucao = resolucao;
    return 'unknown';
  };
}

/** Replay só depois de provada a não aplicação. */
function autorizarReplay(estado: Estado) {
  return (id: string): OutboxStatus => {
    const linha = estado.linhas.get(id);
    if (!linha || linha.status !== 'unknown' || linha.resolucao !== 'provado_nao_aplicado') throw new Error('55000');
    linha.status = 'pending';
    linha.resolucao = null;
    linha.motivoBloqueio = null;
    linha.nextRetryAt = estado.agora();
    return 'pending';
  };
}

export function criarOutboxFake(opcoes: { readonly agora?: () => number } = {}) {
  const estado: Estado = { linhas: new Map(), agora: opcoes.agora ?? (() => Date.now()) };
  return {
    outbox: portaFake(estado),
    // O worker só repassa o cliente para a porta; o fake não o usa.
    fakeSupabase: {} as SupabaseClient,
    linhas: estado.linhas,
    definirRelogio(novo: () => number) {
      estado.agora = novo;
    },
    registrar(id: string, maxAttempts = 3, organizacaoId = 'org-a'): LinhaFake {
      const linha: LinhaFake = {
        id, organizacaoId, status: 'pending', attempts: 0, maxAttempts, nextRetryAt: 0,
        leaseOwner: null, leaseExpiresAt: null, fencingToken: 0, reciboRef: null,
        motivoBloqueio: null, resolucao: null, tentativas: [],
      };
      estado.linhas.set(id, linha);
      return linha;
    },
    reconciliar: reconciliar(estado),
    autorizarReplay: autorizarReplay(estado),
  };
}
