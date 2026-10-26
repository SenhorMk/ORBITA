import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatwootMessage } from '@/types';

/**
 * MSG-003B: o espelho do navegador lê e assina pelo UUID local. O cliente
 * Supabase é dublado só para gravar a cadeia de chamadas e entregar eventos
 * Realtime sintéticos.
 */

const ORG_A = 'a0000000-0000-4000-8000-00000000000a';
const ORG_B = 'b0000000-0000-4000-8000-00000000000b';
const CONVERSA = 'c0000000-0000-4000-8000-000000000001';
const OUTRA_CONVERSA = 'c0000000-0000-4000-8000-000000000002';

const dublê = vi.hoisted(() => ({
  chamadas: [] as Array<[string, ...unknown[]]>,
  aoEvento: null as ((payload: { new: Record<string, unknown> }) => void) | null,
  filtroRealtime: null as Record<string, unknown> | null,
}));

vi.mock('@/lib/supabaseClient', () => {
  const cadeia: Record<string, unknown> = {};
  for (const metodo of ['select', 'eq', 'order']) {
    cadeia[metodo] = (...args: unknown[]) => {
      dublê.chamadas.push([metodo, ...args]);
      return cadeia;
    };
  }
  cadeia.then = (resolve: (v: unknown) => void) => resolve({ data: [], error: null });
  const canal = {
    on: (_tipo: string, filtro: Record<string, unknown>, aoEvento: (payload: { new: Record<string, unknown> }) => void) => {
      dublê.filtroRealtime = filtro;
      dublê.aoEvento = aoEvento;
      return canal;
    },
    subscribe: () => canal,
  };
  return {
    supabase: {
      from: (tabela: string) => {
        dublê.chamadas.push(['from', tabela]);
        return cadeia;
      },
      channel: () => canal,
      removeChannel: () => Promise.resolve(),
    },
  };
});

const linhaDoBanco = (sobrescrever: Record<string, unknown>) => ({
  id: 500,
  id_externo: '500',
  conversation_id: 50,
  sender_id: 5,
  id_local: 'e0000000-0000-4000-8000-000000000001',
  organizacao_id: ORG_A,
  conexao_id: 'f0000000-0000-4000-8000-000000000001',
  conversa_id_local: CONVERSA,
  content: 'oi',
  message_type: 'incoming',
  created_at: '2026-10-26T12:00:00Z',
  ...sobrescrever,
});

describe('espelho do navegador (MSG-003B)', () => {
  beforeEach(() => {
    dublê.chamadas.length = 0;
    dublê.aoEvento = null;
    dublê.filtroRealtime = null;
  });

  it('o histórico é lido pelo UUID local da conversa, sem colunas de id remoto', async () => {
    const { espelhoSupabase } = await import('./espelhoDaMensageria');
    await espelhoSupabase.lerMensagens(ORG_A, CONVERSA);
    expect(dublê.chamadas).toContainEqual(['eq', 'organizacao_id', ORG_A]);
    expect(dublê.chamadas).toContainEqual(['eq', 'conversa_id_local', CONVERSA]);
    const [, colunas] = dublê.chamadas.find(([m]) => m === 'select')!;
    const lidas = String(colunas).split(/,\s*/u);
    for (const remota of ['id', 'id_externo', 'conversation_id', 'sender_id']) expect(lidas).not.toContain(remota);
    expect(dublê.chamadas.some(([m, coluna]) => m === 'eq' && coluna === 'conversation_id')).toBe(false);
  });

  it('as conversas vêm com o contato pela FK composta do UUID local', async () => {
    const { espelhoSupabase } = await import('./espelhoDaMensageria');
    await espelhoSupabase.lerConversas(ORG_A);
    const [, colunas] = dublê.chamadas.find(([m]) => m === 'select')!;
    expect(String(colunas)).toContain('contact:chatwoot_contacts!fk_chatwoot_conversations_contato_local(');
    expect(String(colunas)).not.toMatch(/\bcontact_id\b|\bdisplay_id\b|\binbox_id\b|(^|,\s*)id(,|$)/u);
  });

  it('o tempo real filtra pelo UUID, descarta outra organização ou conversa e não entrega o id remoto', async () => {
    const { espelhoSupabase } = await import('./espelhoDaMensageria');
    const recebidas: ChatwootMessage[] = [];
    espelhoSupabase.assinarMensagens(ORG_A, CONVERSA, (m) => recebidas.push(m), () => undefined);
    expect(dublê.filtroRealtime).toMatchObject({ table: 'chatwoot_messages', filter: `conversa_id_local=eq.${CONVERSA}` });

    dublê.aoEvento!({ new: linhaDoBanco({ organizacao_id: ORG_B }) });
    dublê.aoEvento!({ new: linhaDoBanco({ conversa_id_local: OUTRA_CONVERSA }) });
    dublê.aoEvento!({ new: linhaDoBanco({}) });

    expect(recebidas).toHaveLength(1);
    expect(recebidas[0]).toMatchObject({ id_local: 'e0000000-0000-4000-8000-000000000001', conversa_id_local: CONVERSA, content: 'oi' });
    expect(recebidas[0]).not.toHaveProperty('id');
    expect(recebidas[0]).not.toHaveProperty('conversation_id');
    expect(recebidas[0]).not.toHaveProperty('sender_id');
  });
});
