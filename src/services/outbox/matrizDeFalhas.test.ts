/**
 * MSG-007 — a matriz de 17 falhas de `02-arquitetura.md` aplicada ao envio de
 * mensagem do Chatwoot, com provedor fake e o worker real.
 *
 * O provedor fake registra cada pedido que recebeu e se o efeito aconteceu,
 * para que "sem segundo despacho" seja medido, não presumido. A outbox é o
 * fake com as regras da migration 86; as mesmas regras contra o Postgres real
 * estão no pgTAP `efeito_ambiguo_na_outbox.test.sql` e no ensaio de
 * concorrência `database-concurrency-outbox.mjs`.
 *
 * Casos que não se aplicam a esta fatia estão no fim, com a justificativa.
 */
import { describe, expect, it, vi } from 'vitest';

import { criarOutboxFake } from '@/services/__testkit__/outboxFake';
import type { ChatwootApiResult, ChatwootMessage } from '@/services/chatwoot/chatwootPort';
import { desfechoDoEnvioChatwoot, explicarEstado, podeRepetir, type DesfechoDoDespacho } from './desfechoDoEfeito';
import { runOutboxWorkerOnce, type OutboxProviderAdapter } from './outboxWorker';

type Resposta = ChatwootApiResult<ChatwootMessage>;

/** Um Chatwoot de mentira: cada chamada consome a próxima resposta roteirizada. */
function chatwootFake(roteiro: Array<{ readonly aplicou: boolean; readonly resposta: Resposta }>) {
  const chamadas: number[] = [];
  let aplicados = 0;
  const adapter: OutboxProviderAdapter = async () => {
    const passo = roteiro[chamadas.length] ?? roteiro[roteiro.length - 1]!;
    chamadas.push(chamadas.length + 1);
    if (passo.aplicou) aplicados += 1;
    return desfechoDoEnvioChatwoot(passo.resposta);
  };
  return { adapter, chamadas, aplicados: () => aplicados };
}

const OK: Resposta = { _tag: 'ChatwootSuccess', data: { id: 4242 } as ChatwootMessage };
const falha = (reason: Extract<Resposta, { _tag: 'ChatwootFailed' }>['reason'], status?: number): Resposta =>
  ({ _tag: 'ChatwootFailed', reason, status, retryable: true });

async function passadas(fake: ReturnType<typeof criarOutboxFake>, adapter: OutboxProviderAdapter, n: number, workerId = 'w1') {
  const resumos = [];
  for (let i = 0; i < n; i++) {
    resumos.push(await runOutboxWorkerOnce({ supabase: fake.fakeSupabase, workerId, providers: { chatwoot: adapter }, outbox: fake.outbox }));
    // A fila só reentrega o que estiver devido: o tempo anda entre passadas.
    const depois = Date.now() + (i + 1) * 3_600_000;
    fake.definirRelogio(() => depois);
  }
  return resumos;
}

describe('MSG-007 — matriz de falhas do envio Chatwoot pela outbox', () => {
  it('1. antes do envio: prova de transporte não iniciado → retry da mesma intenção, com limite', async () => {
    const fake = criarOutboxFake();
    const linha = fake.registrar('e1', 3);
    const naoIniciado: OutboxProviderAdapter = vi.fn(async (): Promise<DesfechoDoDespacho> => (
      { _tag: 'NaoEnviado', prova: 'transporte_nao_iniciado', erro: 'DNS não resolveu' }));
    await passadas(fake, naoIniciado, 5);
    expect(naoIniciado).toHaveBeenCalledTimes(3);
    expect(linha.status).toBe('dead_letter');
    expect(linha.tentativas.map((t) => t.token)).toEqual([1, 2, 3]);
  });

  it('2. recusa definitiva: dead_letter, sem retry', async () => {
    const fake = criarOutboxFake();
    const linha = fake.registrar('e1');
    const chatwoot = chatwootFake([{ aplicou: false, resposta: falha('http', 422) }]);
    await passadas(fake, chatwoot.adapter, 3);
    expect(chatwoot.chamadas).toHaveLength(1);
    expect(linha.status).toBe('dead_letter');
    expect(explicarEstado({ status: linha.status, motivoBloqueio: null, resolucao: null })).toMatch(/novo envio/u);
  });

  it('3. timeout: UNKNOWN, sem segundo despacho mesmo com o efeito aplicado', async () => {
    const fake = criarOutboxFake();
    const linha = fake.registrar('e1');
    const chatwoot = chatwootFake([{ aplicou: true, resposta: falha('timeout') }]);
    await passadas(fake, chatwoot.adapter, 4);
    expect(chatwoot.chamadas).toHaveLength(1);
    expect(chatwoot.aplicados()).toBe(1);
    expect(linha.status).toBe('unknown');
    expect(linha.motivoBloqueio).toBe('timeout');
  });

  it('4. ACK perdido: UNKNOWN sem segundo despacho; nunca sent sem recibo', async () => {
    const fake = criarOutboxFake();
    const linha = fake.registrar('e1');
    const chatwoot = chatwootFake([{ aplicou: true, resposta: falha('network') }]);
    await passadas(fake, chatwoot.adapter, 4);
    expect(chatwoot.chamadas).toHaveLength(1);
    expect(linha.status).toBe('unknown');
    expect(linha.motivoBloqueio).toBe('ack_perdido');
    expect(linha.reciboRef).toBeNull();
  });

  it('5. 2xx inválido: UNKNOWN para criação; confirmado sem recibo também', async () => {
    const fake = criarOutboxFake();
    const invalida = fake.registrar('invalida');
    const semRecibo = fake.registrar('sem-recibo');
    const chatwoot = chatwootFake([{ aplicou: true, resposta: falha('invalid-response') }]);
    const mentiroso: OutboxProviderAdapter = async (event) =>
      (event.evento_id === 'sem-recibo' ? { _tag: 'Confirmado', recibo: '' } : chatwoot.adapter(event));
    await passadas(fake, mentiroso, 3);
    expect(invalida.status).toBe('unknown');
    expect(invalida.motivoBloqueio).toBe('resposta_invalida');
    expect(semRecibo.status).toBe('unknown');
    expect(semRecibo.reciboRef).toBeNull();
  });

  it('6. 429 sem prova (Chatwoot) é UNKNOWN; 429 com prova documentada honra Retry-After', async () => {
    const fake = criarOutboxFake({ agora: () => 0 });
    const semProva = fake.registrar('sem-prova');
    const comProva = fake.registrar('com-prova');
    const chatwoot = chatwootFake([{ aplicou: false, resposta: falha('rate-limited', 429) }]);
    const adapter: OutboxProviderAdapter = async (event) => (event.evento_id === 'com-prova'
      ? { _tag: 'NaoEnviado', prova: 'nao_aplicacao_documentada', retryAfterSeconds: 120, erro: '429' }
      : chatwoot.adapter(event));
    await runOutboxWorkerOnce({ supabase: fake.fakeSupabase, workerId: 'w1', providers: { chatwoot: adapter }, outbox: fake.outbox });
    expect(semProva.status).toBe('unknown');
    expect(semProva.motivoBloqueio).toBe('limite_sem_prova');
    expect(comProva.status).toBe('failed_transient');
    expect(comProva.nextRetryAt).toBe(120_000);
    fake.definirRelogio(() => 119_000);
    expect(await fake.outbox.claimBatch(fake.fakeSupabase, 'w2')).toHaveLength(0);
    fake.definirRelogio(() => 120_000);
    expect((await fake.outbox.claimBatch(fake.fakeSupabase, 'w2')).map((e) => e.evento_id)).toEqual(['com-prova']);
  });

  it('7. 5xx: não presume falha sem efeito — UNKNOWN', async () => {
    const fake = criarOutboxFake();
    const linha = fake.registrar('e1');
    const chatwoot = chatwootFake([{ aplicou: true, resposta: falha('http', 503) }]);
    await passadas(fake, chatwoot.adapter, 3);
    expect(chatwoot.chamadas).toHaveLength(1);
    expect(linha.status).toBe('unknown');
    expect(linha.motivoBloqueio).toBe('erro_do_provedor');
  });

  it('8. retry automático só pela allowlist de desfechos: os que não provam não aplicação nunca voltam', async () => {
    const respostas: Resposta[] = [falha('timeout'), falha('network'), falha('invalid-response'), falha('rate-limited', 429), falha('http', 500)];
    for (const r of respostas) {
      expect(desfechoDoEnvioChatwoot(r)._tag).toBe('Desconhecido');
    }
    expect(desfechoDoEnvioChatwoot(falha('http', 401))).toMatchObject({ _tag: 'Recusado', categoria: 'auth_expired' });
    expect(desfechoDoEnvioChatwoot(OK)).toEqual({ _tag: 'Confirmado', recibo: '4242', resposta: { id: 4242 } });
  });

  it('9. retry humano: UNKNOWN não oferece repetir até a não aplicação ser provada', async () => {
    const fake = criarOutboxFake();
    const linha = fake.registrar('e1');
    await passadas(fake, chatwootFake([{ aplicou: true, resposta: falha('timeout') }]).adapter, 1);
    const estado = () => ({ status: linha.status, motivoBloqueio: linha.motivoBloqueio, resolucao: linha.resolucao });
    expect(podeRepetir(estado())).toBe(false);
    expect(explicarEstado(estado())).toMatch(/Não reenvie/u);
    expect(() => fake.autorizarReplay('e1')).toThrow('55000');
    fake.reconciliar('e1', 'provado_nao_aplicado');
    expect(podeRepetir(estado())).toBe(true);
    fake.autorizarReplay('e1');
    const chatwoot = chatwootFake([{ aplicou: true, resposta: OK }]);
    await passadas(fake, chatwoot.adapter, 1);
    expect(linha.status).toBe('sent');
    expect(linha.tentativas.map((t) => t.token)).toEqual([1, 2]);
  });

  it('10. crash depois do efeito: in_flight vencido → UNKNOWN pelo reaper, nunca pending', async () => {
    let agora = 0;
    const fake = criarOutboxFake({ agora: () => agora });
    const linha = fake.registrar('e1');
    // O provedor aplica e o processo morre antes de gravar o desfecho.
    const crash: OutboxProviderAdapter = async () => {
      agora = 10_000_000;
      throw new Error('processo encerrado');
    };
    const morto = { ...fake.outbox, concludeAttempt: vi.fn(async () => null) };
    await runOutboxWorkerOnce({ supabase: fake.fakeSupabase, workerId: 'w1', providers: { chatwoot: crash }, outbox: morto });
    expect(linha.status).toBe('in_flight');
    const segundo = chatwootFake([{ aplicou: true, resposta: OK }]);
    const resumo = await runOutboxWorkerOnce({ supabase: fake.fakeSupabase, workerId: 'w2', providers: { chatwoot: segundo.adapter }, outbox: fake.outbox });
    expect(resumo.reaped).toBe(1);
    expect(linha.status).toBe('unknown');
    expect(linha.motivoBloqueio).toBe('lease_expirada_em_voo');
    expect(segundo.chamadas).toHaveLength(0);
  });

  it('11. falha antes do commit do despacho: nada é enviado', async () => {
    const fake = criarOutboxFake();
    fake.registrar('e1');
    const chatwoot = chatwootFake([{ aplicou: true, resposta: OK }]);
    const quebrado = { ...fake.outbox, startDispatch: vi.fn(async () => { throw new Error('conexão com o banco caiu'); }) };
    await expect(runOutboxWorkerOnce({ supabase: fake.fakeSupabase, workerId: 'w1', providers: { chatwoot: chatwoot.adapter }, outbox: quebrado }))
      .rejects.toThrow('conexão com o banco caiu');
    expect(chatwoot.chamadas).toHaveLength(0);
  });

  it('12. duplicata: dois workers não despacham a mesma intenção', async () => {
    const fake = criarOutboxFake();
    fake.registrar('e1');
    const chatwoot = chatwootFake([{ aplicou: true, resposta: OK }]);
    await Promise.all(['wA', 'wB'].map((workerId) =>
      runOutboxWorkerOnce({ supabase: fake.fakeSupabase, workerId, providers: { chatwoot: chatwoot.adapter }, outbox: fake.outbox })));
    expect(chatwoot.chamadas).toHaveLength(1);
  });

  it('13. fora de ordem: conclusão atrasada não regride um terminal', async () => {
    const fake = criarOutboxFake();
    const linha = fake.registrar('e1');
    const [evento] = await fake.outbox.claimBatch(fake.fakeSupabase, 'w1');
    await fake.outbox.startDispatch(fake.fakeSupabase, 'e1', 'w1', evento!.fencing_token);
    const posse = { eventoId: 'e1', workerId: 'w1', fencingToken: evento!.fencing_token };
    expect(await fake.outbox.concludeAttempt(fake.fakeSupabase, posse, { _tag: 'Confirmado', recibo: '1' })).toBe('sent');
    expect(await fake.outbox.concludeAttempt(fake.fakeSupabase, posse, { _tag: 'NaoEnviado', prova: 'transporte_nao_iniciado', erro: 'x' })).toBeNull();
    expect(linha.status).toBe('sent');
  });

  it('14. atrasado: o worker antigo, com o mesmo id e token velho, não conclui sobre o novo dono', async () => {
    let agora = 0;
    const fake = criarOutboxFake({ agora: () => agora });
    const linha = fake.registrar('e1');
    const [antigo] = await fake.outbox.claimBatch(fake.fakeSupabase, 'w1', 20, 60);
    agora = 61_000;
    await fake.outbox.releaseExpiredLeases(fake.fakeSupabase);
    const [novo] = await fake.outbox.claimBatch(fake.fakeSupabase, 'w1', 20, 60);
    expect(novo!.fencing_token).toBe(antigo!.fencing_token + 1);
    await fake.outbox.startDispatch(fake.fakeSupabase, 'e1', 'w1', novo!.fencing_token);
    expect(await fake.outbox.startDispatch(fake.fakeSupabase, 'e1', 'w1', antigo!.fencing_token)).toBe(false);
    expect(await fake.outbox.concludeAttempt(fake.fakeSupabase, { eventoId: 'e1', workerId: 'w1', fencingToken: antigo!.fencing_token },
      { _tag: 'NaoEnviado', prova: 'transporte_nao_iniciado', erro: 'x' })).toBeNull();
    expect(linha.status).toBe('in_flight');
  });

  it('17. reconciliação: só com a referência exata; ambiguidade fica com humano', () => {
    const fake = criarOutboxFake();
    const linha = fake.registrar('e1');
    linha.status = 'unknown';
    linha.motivoBloqueio = 'timeout';
    expect(() => fake.reconciliar('e1', 'confirmado')).toThrow('22023');
    expect(fake.reconciliar('e1', 'revisao_manual')).toBe('unknown');
    expect(podeRepetir({ status: 'unknown', motivoBloqueio: 'timeout', resolucao: 'revisao_manual' })).toBe(false);
    expect(fake.reconciliar('e1', 'confirmado', '4242')).toBe('sent');
    expect(() => fake.reconciliar('e1', 'revisao_manual')).toThrow('55000');
  });

  // Não se aplicam a esta fatia (MSG-007 não tem efeito inbound nem compensação):
  // 15. Webhook repetido — dedup de entrega é da inbox (MSG-005); a outbox não
  //     consome webhooks. A dedup da intenção de saída é o caso 12 e o pgTAP 30-31.
  // 16. Compensação — nenhum comando compensatório existe aqui; o que se prova é
  //     que nenhuma "reversão" mapeia UNKNOWN para pending (pgTAP 5-6, caso 9).
  // Controle de atendimento (`control_version`, caso 14 da matriz) é do MSG-009;
  // aqui o "atrasado" é o worker antigo, cercado pelo fencing token.
});
