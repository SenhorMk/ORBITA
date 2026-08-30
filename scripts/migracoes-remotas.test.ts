import { describe, expect, it, vi } from 'vitest';

import {
  adotarEstadoAtual,
  aplicarPendentes,
  estadoDasMigracoes,
  lerAlvo,
} from './migracoes-remotas.mjs';

/**
 * O script existe porque mesclar o PR não aplica o SQL. Em 2026-08-30 o banco
 * de produção estava três migrações atrás e a correção do PR #40 foi anunciada
 * como entregue sem existir lá.
 */

const LEDGER = {
  _tag: 'ok' as const,
  value: {
    migrations: [
      { order: 1, path: '../database/01_a.sql', sha256: 'aaa' },
      { order: 2, path: '../database/02_b.sql', sha256: 'bbb' },
      { order: 3, path: '../database/03_c.sql', sha256: 'ccc' },
    ],
  },
};

/** Cliente falso: guarda o que foi executado e responde o registro combinado. */
function clienteFalso(
  registradas: Array<{ arquivo: string; sha256: string }>,
  opcoes: { falharEm?: string; registroExiste?: boolean } = {},
) {
  const { falharEm, registroExiste = true } = opcoes;
  const executados: string[] = [];
  return {
    executados,
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      executados.push(sql.trim().split('\n')[0]!.trim());
      if (falharEm && sql.includes(falharEm)) throw new Error('syntax error at or near "boom"');
      if (/to_regclass/u.test(sql)) return { rows: [{ existe: registroExiste }] };
      if (/select arquivo, sha256 from/u.test(sql)) return { rows: registradas };
      if (/insert into public\.migracoes_aplicadas/u.test(sql)) {
        registradas.push({ arquivo: String(params?.[1]), sha256: String(params?.[2]) });
        return { rows: [] };
      }
      return { rows: [] };
    }),
  };
}

describe('estado das migrações num banco remoto', () => {
  it('lista como pendente tudo que o banco ainda não registrou', async () => {
    const client = clienteFalso([{ arquivo: '../database/01_a.sql', sha256: 'aaa' }]);

    const r = await estadoDasMigracoes({ client, ledgerResult: LEDGER });

    expect(r._tag).toBe('ok');
    if (r._tag !== 'ok') return;
    expect(r.value.aplicadas).toBe(1);
    expect(r.value.pendentes.map((m) => m.path)).toEqual([
      '../database/02_b.sql',
      '../database/03_c.sql',
    ]);
  });

  it('não reporta pendência num banco em dia', async () => {
    const client = clienteFalso(LEDGER.value.migrations.map((m) => ({ arquivo: m.path, sha256: m.sha256 })));

    const r = await estadoDasMigracoes({ client, ledgerResult: LEDGER });

    expect(r._tag === 'ok' && r.value.pendentes).toEqual([]);
  });

  it('acusa migration aplicada cujo conteúdo mudou depois', async () => {
    const client = clienteFalso([{ arquivo: '../database/01_a.sql', sha256: 'OUTRO' }]);

    const r = await estadoDasMigracoes({ client, ledgerResult: LEDGER });

    expect(r._tag === 'ok' && r.value.divergentes).toEqual(['../database/01_a.sql']);
  });

  it('consultar o estado NÃO escreve no banco alvo', async () => {
    const client = clienteFalso([]);

    await estadoDasMigracoes({ client, ledgerResult: LEDGER });

    // A primeira versão criava a tabela de registro aqui, e com isso o caminho
    // anunciado como "somente leitura" emitia DDL em produção.
    expect(client.executados.some((s) => /create table/iu.test(s))).toBe(false);
  });

  it('num banco sem registro nenhum, reporta a ausência em vez de criar a tabela', async () => {
    const client = clienteFalso([], { registroExiste: false });

    const r = await estadoDasMigracoes({ client, ledgerResult: LEDGER });

    expect(r._tag).toBe('ok');
    if (r._tag !== 'ok') return;
    expect(r.value.registroAusente).toBe(true);
    expect(r.value.pendentes).toHaveLength(3);
    expect(client.executados.some((s) => /create table/iu.test(s))).toBe(false);
  });
});

describe('aplicação das pendentes', () => {
  const fileSystem = { readFileSync: () => 'create table exemplo ();' } as never;

  it('aplica em ordem, cada uma na sua transação, e registra cada uma', async () => {
    const registradas: Array<{ arquivo: string; sha256: string }> = [];
    const client = clienteFalso(registradas);

    const r = await aplicarPendentes({
      client,
      pendentes: LEDGER.value.migrations,
      fileSystem,
      log: () => {},
    });

    expect(r._tag === 'ok' && r.value).toEqual([
      '../database/01_a.sql',
      '../database/02_b.sql',
      '../database/03_c.sql',
    ]);
    expect(registradas).toHaveLength(3);
    expect(client.executados.filter((s) => s === 'commit')).toHaveLength(3);
  });

  it('reverte a que falhou e preserva as anteriores', async () => {
    const registradas: Array<{ arquivo: string; sha256: string }> = [];
    let chamada = 0;
    const fsQueFalhaNaTerceira = {
      readFileSync: () => {
        chamada += 1;
        return chamada === 3 ? 'boom' : 'create table exemplo ();';
      },
    } as never;
    const client = clienteFalso(registradas, { falharEm: 'boom' });

    const r = await aplicarPendentes({
      client,
      pendentes: LEDGER.value.migrations,
      fileSystem: fsQueFalhaNaTerceira,
      log: () => {},
    });

    expect(r._tag).toBe('err');
    if (r._tag !== 'err') return;
    expect(r.error.arquivo).toBe('../database/03_c.sql');
    expect(r.error.aplicadasAntes).toEqual(['../database/01_a.sql', '../database/02_b.sql']);
    expect(client.executados).toContain('rollback');
    // As duas primeiras continuam registradas: a próxima execução retoma daqui.
    expect(registradas.map((x) => x.arquivo)).toEqual([
      '../database/01_a.sql',
      '../database/02_b.sql',
    ]);
  });
});

describe('adoção do estado atual', () => {
  it('registra o ledger inteiro sem executar nenhuma migration', async () => {
    const registradas: Array<{ arquivo: string; sha256: string }> = [];
    const client = clienteFalso(registradas);

    const r = await adotarEstadoAtual({ client, ledgerResult: LEDGER });

    expect(r._tag === 'ok' && r.value).toBe(3);
    expect(registradas).toHaveLength(3);
    expect(client.executados.some((s) => s.startsWith('create table exemplo'))).toBe(false);
  });
});

describe('alvo do banco', () => {
  it('recusa rodar sem alvo explícito', () => {
    const r = lerAlvo([], {});
    expect(r._tag).toBe('err');
    expect(r._tag === 'err' && r.error._tag).toBe('AlvoNaoInformado');
  });

  it('aceita --url', () => {
    const r = lerAlvo(['--url', 'postgresql://alvo'], {});
    expect(r._tag === 'ok' && r.value).toBe('postgresql://alvo');
  });

  it('aceita SUPABASE_DB_URL', () => {
    const r = lerAlvo([], { SUPABASE_DB_URL: 'postgresql://do-ambiente' });
    expect(r._tag === 'ok' && r.value).toBe('postgresql://do-ambiente');
  });

  it('o argumento explícito vence a variável de ambiente', () => {
    const r = lerAlvo(['--url', 'postgresql://explicito'], { SUPABASE_DB_URL: 'postgresql://ambiente' });
    expect(r._tag === 'ok' && r.value).toBe('postgresql://explicito');
  });
});
