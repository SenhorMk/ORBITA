import { describe, expect, it } from 'vitest';

import { ChatwootAdapter } from './chatwootAdapter';
import { ChatwootMessageSchema, ChatwootWebhookEventSchema } from './chatwootPort';
import { traduzirEventoDaInbox } from './chatwootWebhookPersistence';
import { chaveDoEventoChatwoot } from '../chatwootInboxService';
import capturas from './__fixtures__/chatwoot-v4.19.1-webhooks.json';

/**
 * Payloads capturados do Chatwoot CE 4.19.1 real (MSG-001), com dados sintéticos e
 * tokens redigidos. São o contrato: se o formato mudar numa nova versão, a fixture
 * muda junto, depois de repetir `npm run test:chatwoot`.
 */

function lido(nome: keyof typeof capturas) {
  const r = ChatwootWebhookEventSchema.safeParse(capturas[nome]);
  if (!r.success) throw new Error(`${nome}: ${r.error.message}`);
  return r.data;
}

function traduzido(nome: keyof typeof capturas) {
  const evento = lido(nome);
  const inbox = Number(evento.inbox?.id ?? evento.conversation?.inbox_id);
  const t = traduzirEventoDaInbox(evento.event, inbox, evento);
  if (t._tag !== 'Comando') throw new Error(`${nome}: ${t._tag}`);
  return t.comando;
}

describe('contrato real do Chatwoot 4.19.1', () => {
  it('preserva a criação e distingue ausência de responsável de informação ausente', () => {
    const original = lido('conversa_criada');
    expect(original.conversation).toMatchObject({ id: 1, inbox_id: 3, created_at: 1793605011, assignee_id: null });
    expect(ChatwootWebhookEventSchema.parse(original).conversation).toEqual(original.conversation);
    const atualizado = ChatwootWebhookEventSchema.parse({
      ...capturas.conversa_criada, event: 'conversation_updated', meta: { assignee: { id: 31, name: 'Operador' } },
    });
    expect(atualizado.conversation?.assignee_id).toBe(31);
    const incompleto = ChatwootWebhookEventSchema.parse({ ...capturas.conversa_criada, meta: {} });
    expect(incompleto.conversation?.assignee_id).toBeUndefined();
  });

  const adapter = ChatwootAdapter.forTesting({ apiUrl: 'https://chatwoot.test', apiToken: 'token-de-teste', accountId: '1', conexaoId: 'conexao' });
  const respondendo = (corpo: unknown) => (async () => new Response(JSON.stringify(corpo), { status: 200 })) as typeof fetch;

  it('a listagem de conversas vem em data.payload', async () => {
    const r = await adapter.getConversations(respondendo({ data: { meta: {}, payload: [{ id: 1, status: 'open', meta: { sender: { id: 3 } } }] } }));
    expect(r).toMatchObject({ _tag: 'ChatwootSuccess', data: [{ id: 1, meta: { sender: { id: 3 } } }] });
  });

  it('formato desconhecido na listagem é resposta inválida, nunca "sem conversas"', async () => {
    expect(await adapter.getConversations(respondendo({ data: {} }))).toMatchObject({ _tag: 'ChatwootFailed', reason: 'invalid-response' });
  });

  it('formato desconhecido nas mensagens é resposta inválida, nunca "sem mensagens"', async () => {
    expect(await adapter.getMessages(1, respondendo({ data: {} }))).toMatchObject({ _tag: 'ChatwootFailed', reason: 'invalid-response' });
  });

  it('conversa sem mensagens continua sendo lista vazia', async () => {
    expect(await adapter.getMessages(1, respondendo({ meta: {}, payload: [] }))).toEqual({ _tag: 'ChatwootSuccess', data: [] });
  });

  it('uma conversa adiada (snoozed) não derruba a listagem', async () => {
    const r = await adapter.getConversations(respondendo({ data: { payload: [{ id: 1, status: 'snoozed' }, { id: 2, status: 'open' }] } }));
    expect(r).toMatchObject({ _tag: 'ChatwootSuccess', data: [{ id: 1, status: 'snoozed' }, { id: 2, status: 'open' }] });
  });

  it('status fora do que o provedor define continua sendo resposta inválida', async () => {
    expect(await adapter.getConversations(respondendo({ data: { payload: [{ id: 1, status: 'inventado' }] } }))).toMatchObject({ _tag: 'ChatwootFailed', reason: 'invalid-response' });
  });

  it('a resposta da API traz created_at em segundos, e a aplicação recebe ISO', () => {
    const r = ChatwootMessageSchema.parse({ id: 11, content: 'RESPOSTA', message_type: 1, created_at: 1793605011, sender: { id: 3, name: 'Agente', type: 'user' } });
    expect(r.created_at).toBe(new Date(1793605011 * 1000).toISOString());
  });

  it.each(['entrada_do_cliente_api_publica', 'entrada_do_cliente_api_app'] as const)(
    'mensagem do cliente (%s) abre caso, com contato e conversa no espelho',
    (nome) => {
      const c = traduzido(nome);
      expect(c).toMatchObject({ acao: 'espelhar', abre_caso: true, classificacao_inconclusiva: false });
      if (c.acao !== 'espelhar') throw new Error('esperava espelhar');
      expect(c.contato?.id).toBe(3);
      expect(c.contato?.nome).toBe('Contato Sintetico');
      expect(c.conversa).toMatchObject({ id: 1, contato_id: 3, inbox_id: 3, status: 'open', canal: 'Channel::Api' });
      expect(c.mensagem).toMatchObject({ tipo: 'incoming', remetente_tipo: 'contact', remetente_id: 3 });
    },
  );

  it.each(['resposta_do_agente', 'nota_privada', 'mensagem_atualizada'] as const)(
    '%s é espelhada e nunca abre caso',
    (nome) => {
      const c = traduzido(nome);
      expect(c).toMatchObject({ acao: 'espelhar', abre_caso: false, classificacao_inconclusiva: false });
      if (c.acao !== 'espelhar') throw new Error('esperava espelhar');
      expect(c.conversa).toMatchObject({ id: 1, contato_id: 3 });
    },
  );

  it('status vem com a conversa no topo do payload', () => {
    const evento = lido('status_alterado');
    expect(evento.conversation?.inbox_id).toBe(3);
    expect(traduzido('status_alterado')).toMatchObject({
      acao: 'status',
      conversa: { id: 1, status: 'resolved' },
      revisao_status_em: new Date(capturas.status_alterado.updated_at * 1000).toISOString(),
    });
  });

  it('a chave do status usa a conversa: id de topo não é confundido com mensagem', () => {
    const chave = chaveDoEventoChatwoot(lido('status_alterado'), { deliveryId: null, timestampAssinado: '1' });
    expect(chave).toMatch(/^v2:conversation_status_changed:conv:1:/);
  });

  it('remetente sem type só vira cliente com prova: id igual ao contato da conversa', () => {
    const base = capturas.entrada_do_cliente_api_publica;
    const outro = { ...base, sender: { ...base.sender, id: 99 } };
    const evento = ChatwootWebhookEventSchema.parse(outro);
    const t = traduzirEventoDaInbox(evento.event, 3, evento);
    expect(t).toMatchObject({ _tag: 'Comando', comando: { abre_caso: false, classificacao_inconclusiva: true } });
  });

  it('sem sender nenhum continua inconclusiva, mesmo com tipo incoming', () => {
    const evento = ChatwootWebhookEventSchema.parse({ ...capturas.entrada_do_cliente_api_publica, sender: undefined });
    const t = traduzirEventoDaInbox(evento.event, 3, evento);
    expect(t).toMatchObject({ _tag: 'Comando', comando: { abre_caso: false, classificacao_inconclusiva: true } });
  });

  it('mensagem só com anexo (`content: null`) é aceita e vira conteúdo vazio', () => {
    const evento = ChatwootWebhookEventSchema.parse({ ...capturas.entrada_do_cliente_api_publica, content: null });
    const t = traduzirEventoDaInbox(evento.event, 3, evento);
    expect(t).toMatchObject({ _tag: 'Comando', comando: { abre_caso: true, mensagem: { conteudo: '' } } });
  });

  it('o evento normalizado relido da inbox continua igual (o aceite grava, o worker relê)', () => {
    const uma = lido('entrada_do_cliente_api_publica');
    expect(ChatwootWebhookEventSchema.parse(JSON.parse(JSON.stringify(uma)))).toEqual(uma);
    const status = lido('status_alterado');
    expect(ChatwootWebhookEventSchema.parse(JSON.parse(JSON.stringify(status)))).toEqual(status);
  });
});
