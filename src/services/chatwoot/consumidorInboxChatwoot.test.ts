import { afterEach, describe, expect, it, vi } from 'vitest';

import { traduzirEventoDaInbox } from './chatwootWebhookPersistence';
import {
  consumirInboxUmaVez,
  type DesfechoDaAplicacao,
  type EventoReivindicado,
  type PortaDoConsumidorInbox,
} from './consumidorInboxChatwoot';
import { criarPortaDoConsumidorInbox } from './consumidorInboxChatwootSupabase';
import { executarWorkerInbox, lerConfiguracaoDoWorkerInbox } from './workerInboxChatwoot';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * A tradução e o laço. Invariantes de banco (lease, fencing, atomicidade,
 * concorrência) estão em `supabase/tests/final/consumidor_inbox_caso.test.sql` e
 * `scripts/database-concurrency-consumidor-inbox.mjs`: mock não prova isso.
 */

const MENSAGEM = {
  event: 'message_created',
  account: { id: 7 },
  id: 500,
  content: 'oi',
  message_type: 'incoming',
  created_at: '2026-11-01T10:00:00Z',
  conversation: { id: 50, display_id: 5, inbox_id: 1, status: 'open', contact: { id: 5, name: 'Contato' } },
  sender: { id: 5, name: 'Contato', type: 'contact' },
};

function comando(payload: Record<string, unknown>, tipo = String(payload.event)) {
  const t = traduzirEventoDaInbox(tipo, 1, payload);
  if (t._tag !== 'Comando') throw new Error(`esperava comando: ${t.codigo}`);
  return t.comando;
}

describe('traduzirEventoDaInbox', () => {
  it('mensagem recebida do cliente abre caso; o comando não leva organização nem conexão', () => {
    const c = comando(MENSAGEM);
    expect(c).toMatchObject({ acao: 'espelhar', abre_caso: true, revisao_conteudo_em: undefined, revisao_status_em: undefined });
    expect(c.mensagem).toMatchObject({ id: 500, conversa_id: 50, modo: 'preservar' });
    expect(JSON.stringify(c)).not.toMatch(/organizacao|conexao/u);
  });

  it.each([
    ['nota privada', { ...MENSAGEM, private: true }],
    ['resposta de atendente', { ...MENSAGEM, message_type: 'outgoing', sender: { id: 9, type: 'user' } }],
    ['mensagem de sistema', { ...MENSAGEM, message_type: 2 }],
    ['remetente atendente mesmo marcado incoming', { ...MENSAGEM, sender: { id: 9, type: 'agent' } }],
    ['edição', { ...MENSAGEM, event: 'message_updated' }],
    ['sem id de mensagem', { ...MENSAGEM, id: undefined }],
  ])('%s não abre caso', (_nome, payload) => {
    expect(comando(payload).abre_caso).toBe(false);
  });

  it.each([
    ['message_created sem message_type', { ...MENSAGEM, message_type: undefined }],
    ['message_created sem sender.type', { ...MENSAGEM, sender: { id: 5, name: 'Contato' } }],
    ['message_type desconhecido', { ...MENSAGEM, message_type: 'tipo_nao_documentado' }],
    ['sender.type desconhecido', { ...MENSAGEM, sender: { id: 5, type: 'external_unknown' } }],
    ['sender ausente', { ...MENSAGEM, sender: undefined }],
    ['outgoing mesmo com contact', { ...MENSAGEM, message_type: 'outgoing' }],
    ['nota privada com contact', { ...MENSAGEM, private: true }],
    ['system mesmo com contact', { ...MENSAGEM, message_type: 'system' }],
  ])('classificacao sem prova positiva: %s jamais abre TRIAGE', (_nome, payload) => {
    expect(comando(payload).abre_caso).toBe(false);
  });

  it('incoming com remetente comprovadamente contact pode abrir TRIAGE', () => {
    expect(comando({ ...MENSAGEM, message_type: 'incoming', sender: { id: 5, type: 'contact' } }).abre_caso).toBe(true);
  });

  it('tipo de mensagem ausente ou desconhecido nao e inventado como incoming no espelho', () => {
    expect(comando({ ...MENSAGEM, message_type: undefined }).mensagem).toBeUndefined();
    expect(comando({ ...MENSAGEM, message_type: 'tipo_nao_documentado' }).mensagem).toBeUndefined();
  });

  it('edição sobrescreve e a revisão vem do provedor, em ISO ou em segundos', () => {
    expect(comando({ ...MENSAGEM, event: 'message_updated', updated_at: 1793527200 })).toMatchObject({
      revisao_conteudo_em: new Date(1793527200 * 1000).toISOString(),
      mensagem: { modo: 'sobrescrever' },
    });
  });

  it('status leva só o id remoto e o estado', () => {
    expect(comando({ event: 'conversation_status_changed', account: { id: 7 }, conversation: { id: 50, status: 'resolved' } })).toEqual({
      evento: 'conversation_status_changed', acao: 'status', revisao_status_em: undefined, conversa: { id: 50, status: 'resolved' },
    });
  });

  it('evento fora da lista vira ignorar, mesmo com conversa e contato no payload', () => {
    expect(comando({ ...MENSAGEM, event: 'conversation_created' })).toEqual({ evento: 'conversation_created', acao: 'ignorar' });
  });

  it('payload que não cumpre o contrato ou de outro tipo é inválido', () => {
    expect(traduzirEventoDaInbox('message_created', 1, { event: 'message_created' })).toEqual({ _tag: 'PayloadInvalido', codigo: 'payload_invalido' });
    expect(traduzirEventoDaInbox('message_created', 1, MENSAGEM.conversation)).toEqual({ _tag: 'PayloadInvalido', codigo: 'payload_invalido' });
    expect(traduzirEventoDaInbox('message_updated', 1, MENSAGEM)).toEqual({ _tag: 'PayloadInvalido', codigo: 'payload_invalido' });
    expect(traduzirEventoDaInbox('conversation_status_changed', 1, { event: 'conversation_status_changed', account: { id: 7 } })).toEqual({ _tag: 'PayloadInvalido', codigo: 'payload_invalido' });
  });

  it('id que não cabe no espelho é inválido, sem truncar', () => {
    expect(traduzirEventoDaInbox('message_created', 1, { ...MENSAGEM, id: 3_000_000_000 })).toEqual({ _tag: 'PayloadInvalido', codigo: 'id_fora_da_faixa' });
  });
});

const EVENTO: EventoReivindicado = {
  eventoId: '11111111-1111-4111-8111-111111111111', organizacaoId: '22222222-2222-4222-8222-222222222222',
  conexaoId: '33333333-3333-4333-8333-333333333333', inboxId: 1, eventType: 'message_created', payload: MENSAGEM,
  correlationId: 'del-1', fencingToken: 3, tentativa: 1,
};

function porta(desfecho: DesfechoDaAplicacao | Error, lote: readonly EventoReivindicado[] = [EVENTO]) {
  return {
    reivindicar: vi.fn(async () => lote),
    aplicar: vi.fn(async () => {
      if (desfecho instanceof Error) throw desfecho;
      return desfecho;
    }),
    registrarFalha: vi.fn(async () => true),
  } satisfies PortaDoConsumidorInbox;
}

const OPCOES = { workerId: 'w1', limite: 10, leaseSegundos: 60, recebidosDesde: '2026-11-01T00:00:00Z' };

describe('consumirInboxUmaVez', () => {
  it('conta cada desfecho e não registra falha em sucesso', async () => {
    const p = porta({ _tag: 'Aplicado', disposicao: 'caso_aberto', casoId: 'c' });
    expect(await consumirInboxUmaVez(p, OPCOES)).toMatchObject({ reivindicados: 1, processados: 1, falhas: 0 });
    expect(p.registrarFalha).not.toHaveBeenCalled();
  });

  it('disposição de evento ignorado conta como ignorado', async () => {
    const p = porta({ _tag: 'Aplicado', disposicao: 'evento_desconhecido', casoId: null });
    expect(await consumirInboxUmaVez(p, OPCOES)).toMatchObject({ ignorados: 1, processados: 0 });
  });

  it('posse perdida não grava nada: outro worker é o dono', async () => {
    const p = porta({ _tag: 'PossePerdida' });
    expect(await consumirInboxUmaVez(p, OPCOES)).toMatchObject({ cercados: 1, falhas: 0 });
    expect(p.registrarFalha).not.toHaveBeenCalled();
  });

  it('transação abortada grava falha repetível com o SQLSTATE, sem texto do banco', async () => {
    const p = porta({ _tag: 'FalhaDaTransacao', codigo: '23514' });
    await consumirInboxUmaVez(p, OPCOES);
    expect(p.registrarFalha).toHaveBeenCalledWith(EVENTO, 'w1', 'falha_23514', false);
  });

  it('payload inválido é falha definitiva e nem chega à transação', async () => {
    const p = porta({ _tag: 'PossePerdida' }, [{ ...EVENTO, payload: { event: 'message_created' } }]);
    await consumirInboxUmaVez(p, OPCOES);
    expect(p.aplicar).not.toHaveBeenCalled();
    expect(p.registrarFalha).toHaveBeenCalledWith(expect.anything(), 'w1', 'payload_invalido', true);
  });

  it('sem resposta do banco: não grava falha, porque o commit pode ter acontecido', async () => {
    const p = porta(new Error('socket hang up'));
    expect(await consumirInboxUmaVez(p, OPCOES)).toMatchObject({ semResposta: 1, falhas: 0 });
    expect(p.registrarFalha).not.toHaveBeenCalled();
  });

  it('um evento que falha não impede os seguintes do lote', async () => {
    const p = porta(new Error('x'), [EVENTO, { ...EVENTO, eventoId: '11111111-1111-4111-8111-111111111112' }]);
    expect(await consumirInboxUmaVez(p, OPCOES)).toMatchObject({ reivindicados: 2, semResposta: 2 });
  });

  it('parada pedida: não começa o próximo evento do lote', async () => {
    const p = porta({ _tag: 'Aplicado', disposicao: 'caso_aberto', casoId: 'c' });
    await consumirInboxUmaVez(p, { ...OPCOES, deveParar: () => true });
    expect(p.aplicar).not.toHaveBeenCalled();
  });

  it('logs do consumo não carregam conteúdo, nome nem telefone', async () => {
    const saidas: string[] = [];
    const capturar = (...args: unknown[]) => { saidas.push(args.map(String).join(' ')); };
    const espioes = [
      vi.spyOn(console, 'info').mockImplementation(capturar),
      vi.spyOn(console, 'warn').mockImplementation(capturar),
      vi.spyOn(console, 'error').mockImplementation(capturar),
    ];
    try {
      const payload = { ...MENSAGEM, content: 'CONTEUDO-PRIVADO', sender: { id: 5, name: 'NOME-PRIVADO', type: 'contact' } };
      await consumirInboxUmaVez(porta({ _tag: 'FalhaDaTransacao', codigo: '23514' }, [{ ...EVENTO, payload }]), OPCOES);
    } finally {
      espioes.forEach((s) => s.mockRestore());
    }
    const log = saidas.join('\n');
    expect(log).toContain('chatwoot.inbox.falha');
    expect(log).toContain(EVENTO.organizacaoId);
    expect(log).not.toContain('CONTEUDO-PRIVADO');
    expect(log).not.toContain('NOME-PRIVADO');
  });
});

describe('porta sobre o Supabase', () => {
  const cliente = (resposta: { data?: unknown; error?: { code?: string; message: string } | null }) => {
    const rpc = vi.fn(async () => ({ data: resposta.data ?? null, error: resposta.error ?? null }));
    return { rpc, cliente: { rpc } as unknown as SupabaseClient };
  };

  it('erro com SQLSTATE é aborto conhecido; sem SQLSTATE é commit desconhecido', async () => {
    const abortou = cliente({ error: { code: '23514', message: 'telefone +5511999990001' } });
    expect(await criarPortaDoConsumidorInbox(abortou.cliente).aplicar(EVENTO, 'w1', { evento: 'x', acao: 'ignorar' }))
      .toEqual({ _tag: 'FalhaDaTransacao', codigo: '23514' });

    const semResposta = cliente({ error: { code: '', message: 'fetch failed' } });
    await expect(criarPortaDoConsumidorInbox(semResposta.cliente).aplicar(EVENTO, 'w1', { evento: 'x', acao: 'ignorar' })).rejects.toThrow();
  });

  it('só chama as três RPCs do consumo, com o token e o worker', async () => {
    const c = cliente({ data: [{ desfecho: 'posse_perdida', disposicao: null, caso_id: null }] });
    expect(await criarPortaDoConsumidorInbox(c.cliente).aplicar(EVENTO, 'w1', { evento: 'x', acao: 'ignorar' })).toEqual({ _tag: 'PossePerdida' });
    expect(c.rpc).toHaveBeenCalledWith('aplicar_evento_inbox_chatwoot', expect.objectContaining({ p_worker: 'w1', p_fencing_token: 3 }));
  });

  it('registrarFalha devolve falso quando o fencing recusa', async () => {
    const recusou = cliente({ data: null });
    expect(await criarPortaDoConsumidorInbox(recusou.cliente).registrarFalha(EVENTO, 'w1', 'c', false)).toBe(false);
  });
});

const LIGADO = { CHATWOOT_INBOX_WORKER_ENABLED: 'true', CHATWOOT_INBOX_WORKER_BACKLOG_DESDE: '2026-11-01T00:00:00Z' };

describe('worker: kill switch e configuração', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sem ligar explicitamente: não reivindica nada', async () => {
    const p = porta({ _tag: 'PossePerdida' });
    await executarWorkerInbox(p, lerConfiguracaoDoWorkerInbox({}), new AbortController().signal);
    expect(p.reivindicar).not.toHaveBeenCalled();
  });

  it('ligado sem o corte do backlog: recusa a partida', () => {
    expect(() => lerConfiguracaoDoWorkerInbox({ CHATWOOT_INBOX_WORKER_ENABLED: 'true' })).toThrow(/BACKLOG_DESDE/u);
    expect(() => lerConfiguracaoDoWorkerInbox({ CHATWOOT_INBOX_WORKER_ENABLED: 'true', CHATWOOT_INBOX_WORKER_BACKLOG_DESDE: 'ontem' })).toThrow();
  });

  it('corte vazio, como vem no .env de modelo, é ausência: desligado sobe, ligado recusa', () => {
    expect(lerConfiguracaoDoWorkerInbox({ CHATWOOT_INBOX_WORKER_ENABLED: 'false', CHATWOOT_INBOX_WORKER_BACKLOG_DESDE: '' }))
      .toMatchObject({ ligado: false, recebidosDesde: null });
    expect(() => lerConfiguracaoDoWorkerInbox({ CHATWOOT_INBOX_WORKER_ENABLED: 'true', CHATWOOT_INBOX_WORKER_BACKLOG_DESDE: '' })).toThrow(/BACKLOG_DESDE/u);
  });

  it('o corte chega ao claim', async () => {
    const p = porta({ _tag: 'PossePerdida' }, []);
    await consumirInboxUmaVez(p, OPCOES);
    expect(p.reivindicar).toHaveBeenCalledWith('w1', 10, 60, '2026-11-01T00:00:00Z');
  });

  it('valor fora da faixa ou não reconhecido recusa a partida', () => {
    expect(() => lerConfiguracaoDoWorkerInbox({ CHATWOOT_INBOX_WORKER_ENABLED: 'sim' })).toThrow();
    expect(() => lerConfiguracaoDoWorkerInbox({ CHATWOOT_INBOX_WORKER_LEASE_SECONDS: '1' })).toThrow();
  });

  it('ligado: consome e, com a parada, termina sem pegar lote novo', async () => {
    const parada = new AbortController();
    const p = porta({ _tag: 'Aplicado', disposicao: 'caso_aberto', casoId: 'c' });
    p.reivindicar.mockImplementation(async () => {
      parada.abort();
      return [EVENTO];
    });
    const config = lerConfiguracaoDoWorkerInbox({ ...LIGADO, CHATWOOT_INBOX_WORKER_POLL_MS: '100' });
    await executarWorkerInbox(p, config, parada.signal);
    expect(p.reivindicar).toHaveBeenCalledTimes(1);
    expect(p.aplicar).not.toHaveBeenCalled();
  });

  it('banco fora no claim: não derruba o processo, recua e continua', async () => {
    const parada = new AbortController();
    const p = porta({ _tag: 'PossePerdida' });
    let chamadas = 0;
    p.reivindicar.mockImplementation(async () => {
      chamadas += 1;
      if (chamadas === 2) parada.abort();
      if (chamadas === 1) throw new Error('fora');
      return [];
    });
    const config = lerConfiguracaoDoWorkerInbox({
      ...LIGADO, CHATWOOT_INBOX_WORKER_POLL_MS: '100', CHATWOOT_INBOX_WORKER_IDLE_MAX_MS: '100',
    });
    await executarWorkerInbox(p, config, parada.signal);
    expect(chamadas).toBe(2);
  });
});
