import { describe, expect, it } from 'vitest';

import type { ChatwootMessage } from '@/types';
import { autoriaDaMensagem } from './autoria';
import { rotuloDoCanal } from './CabecalhoDaConversa';
import { montarLinhaDoTempo, rotuloDoDia } from './linhaDoTempo';
import { modoParaLargura } from './useModoDoLayout';

function msg(id: string, campos: Partial<ChatwootMessage>): ChatwootMessage {
  return { id_local: id, conversa_id_local: 'c', content: 'texto', message_type: 'incoming', ...campos };
}

describe('autoria das mensagens', () => {
  it('cliente só com entrada que não veio de atendente; o nome vem do remetente ou do contato', () => {
    expect(autoriaDaMensagem(msg('1', { sender_type: 'contact', sender_name: 'Ana' }))).toEqual({ tipo: 'cliente', rotulo: 'Ana', detalhe: null });
    expect(autoriaDaMensagem(msg('2', { sender_name: null }), 'Ana do contato').rotulo).toBe('Ana do contato');
    expect(autoriaDaMensagem(msg('3', { message_type: '0' })).rotulo).toBe('Cliente');
  });

  it('saída é "Atendimento", com a conta que enviou: nunca "IA" nem "Atendente" por suposição', () => {
    const humana = autoriaDaMensagem(msg('1', { message_type: 'outgoing', sender_type: 'user', sender_name: 'Atendente Orbita' }));
    const semNome = autoriaDaMensagem(msg('2', { message_type: '1', sender_type: null }));
    expect(humana).toEqual({ tipo: 'atendimento', rotulo: 'Atendimento', detalhe: 'Atendente Orbita' });
    expect(semNome).toEqual({ tipo: 'atendimento', rotulo: 'Atendimento', detalhe: null });
    // Entrada marcada como de atendente não vira cliente.
    expect(autoriaDaMensagem(msg('3', { message_type: 'incoming', sender_type: 'user' })).tipo).toBe('atendimento');
  });

  it('atividade é evento do sistema; modelo é atendimento', () => {
    expect(autoriaDaMensagem(msg('1', { message_type: 'activity' })).tipo).toBe('sistema');
    expect(autoriaDaMensagem(msg('2', { message_type: '2' })).tipo).toBe('sistema');
    expect(autoriaDaMensagem(msg('3', { message_type: 'template' }))).toEqual({ tipo: 'atendimento', rotulo: 'Atendimento', detalhe: 'mensagem modelo' });
  });
});

describe('linha do tempo', () => {
  const agora = new Date(2026, 10, 20, 15, 0);
  const em = (dia: number, hora: number, minuto: number) => new Date(2026, 10, dia, hora, minuto).toISOString();

  it('separa os dias com Hoje, Ontem e a data', () => {
    expect(rotuloDoDia(new Date(2026, 10, 20, 9), agora)).toBe('Hoje');
    expect(rotuloDoDia(new Date(2026, 10, 19, 23), agora)).toBe('Ontem');
    expect(rotuloDoDia(new Date(2026, 8, 3, 10), agora)).toMatch(/3 de setembro/u);
    expect(rotuloDoDia(new Date(2025, 8, 3, 10), agora)).toMatch(/2025/u);
  });

  it('agrupa mensagens seguidas do mesmo autor em poucos minutos, e o dia novo reinicia o grupo', () => {
    const itens = montarLinhaDoTempo([
      msg('a', { sender_type: 'contact', sender_name: 'Ana', created_at: em(19, 22, 0) }),
      msg('b', { sender_type: 'contact', sender_name: 'Ana', created_at: em(19, 22, 3) }),
      msg('c', { message_type: 'outgoing', sender_type: 'user', sender_name: 'Loja', created_at: em(19, 22, 4) }),
      msg('d', { sender_type: 'contact', sender_name: 'Ana', created_at: em(19, 22, 30) }),
      msg('e', { sender_type: 'contact', sender_name: 'Ana', created_at: em(20, 0, 1) }),
    ], 'Ana', agora);

    expect(itens.map((i) => (i.tipo === 'dia' ? `dia:${i.rotulo}` : `${i.chave}:${i.continuacao}`))).toEqual([
      'dia:Ontem', 'a:false', 'b:true', 'c:false', 'd:false', 'dia:Hoje', 'e:false',
    ]);
  });

  it('mensagem sem data não abre dia nem agrupa', () => {
    const itens = montarLinhaDoTempo([
      msg('a', { sender_name: 'Ana', created_at: em(20, 10, 0) }),
      msg('b', { sender_name: 'Ana', created_at: undefined }),
    ], 'Ana', agora);
    expect(itens.map((i) => (i.tipo === 'dia' ? 'dia' : `${i.chave}:${i.continuacao}`))).toEqual(['dia', 'a:false', 'b:false']);
  });

  it('eventos do sistema nunca agrupam', () => {
    const itens = montarLinhaDoTempo([
      msg('a', { message_type: 'activity', created_at: em(20, 10, 0) }),
      msg('b', { message_type: 'activity', created_at: em(20, 10, 1) }),
    ], null, agora);
    expect(itens.filter((i) => i.tipo === 'mensagem').every((i) => i.tipo === 'mensagem' && !i.continuacao)).toBe(true);
  });
});

describe('canal e layout', () => {
  it('mostra o canal só quando ele existe, sem inventar', () => {
    expect(rotuloDoCanal('Channel::WebWidget')).toBe('WebWidget');
    expect(rotuloDoCanal('Channel::Whatsapp')).toBe('WhatsApp');
    expect(rotuloDoCanal('Channel::Api')).toBe('Api');
    expect(rotuloDoCanal(null)).toBeNull();
    expect(rotuloDoCanal('  ')).toBeNull();
  });

  it('escolhe o modo pela largura da central', () => {
    expect(modoParaLargura(null)).toBe('amplo');
    expect(modoParaLargura(360)).toBe('compacto');
    expect(modoParaLargura(719)).toBe('compacto');
    expect(modoParaLargura(720)).toBe('medio');
    expect(modoParaLargura(1204)).toBe('medio');
    expect(modoParaLargura(1320)).toBe('amplo');
  });
});
