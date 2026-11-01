import { describe, expect, it } from 'vitest';

import { mapChatwootMessageType, traduzirEventoDaInbox } from './chatwootWebhookPersistence';

/**
 * Só abre caso a mensagem comprovadamente recebida do contato: tipo e remetente
 * positivamente provados. O que não se sabe classificar nunca vira atendimento.
 */

const CLIENTE = {
  event: 'message_created',
  account: { id: 7 },
  id: 500,
  content: 'oi',
  message_type: 'incoming',
  conversation: { id: 50, inbox_id: 1, status: 'open', contact: { id: 5, name: 'Contato' } },
  sender: { id: 5, name: 'Contato', type: 'contact' },
};

function sem<T extends Record<string, unknown>>(objeto: T, chave: keyof T) {
  const copia = { ...objeto };
  delete copia[chave];
  return copia;
}

function comando(payload: Record<string, unknown>) {
  const t = traduzirEventoDaInbox(String(payload.event), 1, payload);
  if (t._tag !== 'Comando') throw new Error(`esperava comando: ${t.codigo}`);
  return t.comando;
}

describe('abertura de caso exige prova positiva', () => {
  it.each([
    ['incoming do contato', CLIENTE],
    ['incoming numérico (0) do contato', { ...CLIENTE, message_type: 0 }],
    ['incoming numérico em texto do contato', { ...CLIENTE, message_type: '0' }],
  ])('%s abre caso', (_nome, payload) => {
    expect(comando(payload).abre_caso).toBe(true);
  });

  it.each([
    ['sem message_type', sem(CLIENTE, 'message_type')],
    ['message_type vazio', { ...CLIENTE, message_type: '' }],
    ['message_type desconhecido', { ...CLIENTE, message_type: 'algo_novo' }],
    ['message_type numérico desconhecido', { ...CLIENTE, message_type: 9 }],
    ['sem sender', sem(CLIENTE, 'sender')],
    ['sem sender.type', { ...CLIENTE, sender: { id: 5, name: 'Contato' } }],
    ['sender.type desconhecido', { ...CLIENTE, sender: { id: 5, type: 'agent_bot' } }],
    ['sender.type em caixa diferente', { ...CLIENTE, sender: { id: 5, type: 'Contact' } }],
    ['outgoing', { ...CLIENTE, message_type: 'outgoing' }],
    ['outgoing numérico', { ...CLIENTE, message_type: 1 }],
    ['nota privada', { ...CLIENTE, private: true }],
    ['system', { ...CLIENTE, message_type: 'system' }],
    ['template', { ...CLIENTE, message_type: 'template' }],
    ['incoming de atendente', { ...CLIENTE, sender: { id: 9, type: 'user' } }],
    ['incoming de agent', { ...CLIENTE, sender: { id: 9, type: 'agent' } }],
    ['outgoing marcado como contato', { ...CLIENTE, message_type: 'outgoing', sender: { id: 5, type: 'contact' } }],
  ])('%s não abre caso', (_nome, payload) => {
    expect(comando(payload).abre_caso).toBe(false);
  });

  it('tipo desconhecido fica registrado no comando e fora do espelho, sem virar incoming', () => {
    const c = comando(sem(CLIENTE, 'message_type'));
    expect(c.classificacao_inconclusiva).toBe(true);
    expect(c.mensagem).toBeUndefined();
  });

  it('remetente desconhecido: a mensagem é espelhada, mas fica inconclusiva e sem caso', () => {
    const c = comando({ ...CLIENTE, sender: { id: 5, type: 'agent_bot' } });
    expect(c).toMatchObject({ classificacao_inconclusiva: true, abre_caso: false, mensagem: { tipo: 'incoming', remetente_tipo: null } });
  });

  it('mensagem classificada, ainda que não abra caso, não é inconclusiva', () => {
    expect(comando({ ...CLIENTE, message_type: 'outgoing', sender: { id: 9, type: 'user' } }).classificacao_inconclusiva).toBe(false);
    expect(comando({ ...CLIENTE, private: true }).classificacao_inconclusiva).toBe(false);
    expect(comando(CLIENTE).classificacao_inconclusiva).toBe(false);
  });

  it('edição nunca é inconclusiva: ela não pretende abrir caso', () => {
    expect(comando({ ...sem(CLIENTE, 'message_type'), event: 'message_updated' }).classificacao_inconclusiva).toBe(false);
  });
});

describe('mapChatwootMessageType', () => {
  it.each([['incoming', 'incoming'], [0, 'incoming'], ['0', 'incoming'], ['outgoing', 'outgoing'], [1, 'outgoing'], ['1', 'outgoing'],
    ['system', 'system'], [2, 'system'], ['2', 'system'], ['template', 'template'], [3, 'template'], ['3', 'template']])(
    '%s é %s', (bruto, esperado) => {
      expect(mapChatwootMessageType(bruto)).toBe(esperado);
    },
  );

  it.each([[undefined], [null], [''], ['algo_novo'], [9], [{}]])('%s é desconhecido, não incoming', (bruto) => {
    expect(mapChatwootMessageType(bruto)).toBeNull();
  });
});
