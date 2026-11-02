import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import { SupabaseRetentionDatabasePort } from './retentionDbAdapter';

const ORG = '0b9a3f5e-0000-4000-8000-00000000000a';
const CONTATO = '7c4d2a10-0000-4000-8000-000000000005';

/** Cliente dublado que só registra a consulta de existência. */
function clienteQueRegistra(contagem: number) {
  const filtros: Array<[string, unknown]> = [];
  const tabelas: string[] = [];
  const consulta = {
    select: () => consulta,
    eq(coluna: string, valor: unknown) {
      filtros.push([coluna, valor]);
      return filtros.length === 2 ? Promise.resolve({ count: contagem, error: null }) : consulta;
    },
  };
  const supabase = {
    from(tabela: string) {
      tabelas.push(tabela);
      return consulta;
    },
  } as unknown as SupabaseClient;
  return { supabase, filtros, tabelas };
}

describe('SupabaseRetentionDatabasePort.entityExists (MSG-004)', () => {
  it('contato Chatwoot é procurado pelo UUID local na organização, nunca pelo id remoto', async () => {
    const { supabase, filtros, tabelas } = clienteQueRegistra(1);
    const existe = await new SupabaseRetentionDatabasePort(supabase).entityExists('chatwoot_contacts', ORG, CONTATO);
    expect(existe).toBe(true);
    expect(tabelas).toEqual(['chatwoot_contacts']);
    expect(filtros).toEqual([['id_local', CONTATO], ['organizacao_id', ORG]]);
  });

  it('item legado pelo id remoto não existe para o preview e não consulta o banco', async () => {
    const { supabase, tabelas } = clienteQueRegistra(2);
    const existe = await new SupabaseRetentionDatabasePort(supabase).entityExists('chatwoot_contacts', ORG, '5');
    expect(existe).toBe(false);
    expect(tabelas).toEqual([]);
  });

  it('cliente continua pelo id', async () => {
    const { supabase, filtros } = clienteQueRegistra(0);
    const existe = await new SupabaseRetentionDatabasePort(supabase).entityExists('clientes', ORG, CONTATO);
    expect(existe).toBe(false);
    expect(filtros).toEqual([['id', CONTATO], ['organizacao_id', ORG]]);
  });
});
