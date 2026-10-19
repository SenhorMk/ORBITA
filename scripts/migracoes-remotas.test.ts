import { createHash } from 'node:crypto';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  adotarEstadoAtual,
  aplicarPendentes,
  estadoDasMigracoes,
  lerAlvo,
  erroReportavel,
  lerLimite,
  lerOpcoes,
  planejarAplicacao,
} from './migracoes-remotas.mjs';
import { failureMessage } from './script-result.mjs';
import { spawnSync } from 'node:child_process';

const sha = (conteudo: string) => createHash('sha256').update(conteudo).digest('hex');

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
      if (/select 1 from public\.migracoes_aplicadas where arquivo/u.test(sql)) {
        return { rows: registradas.filter((r) => r.arquivo === params?.[0]) };
      }
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
  const SQL = 'create table exemplo ();';
  const fileSystem = { readFileSync: () => SQL } as never;
  /** O ledger com o checksum real do conteúdo que o disco falso devolve. */
  const comChecksum = (conteudos: string[]) =>
    LEDGER.value.migrations.map((m, i) => ({ ...m, sha256: sha(conteudos[i] ?? SQL) }));

  it('aplica em ordem, cada uma na sua transação, e registra cada uma', async () => {
    const registradas: Array<{ arquivo: string; sha256: string }> = [];
    const client = clienteFalso(registradas);

    const r = await aplicarPendentes({
      client,
      pendentes: comChecksum([]),
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
      pendentes: comChecksum([SQL, SQL, 'boom']),
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
  it('é recusada num banco que já registra migrations: não marca pendentes sem executá-las', async () => {
    const registradas = [{ arquivo: '../database/01_a.sql', sha256: 'aaa' }];
    const client = clienteFalso(registradas);

    const r = await adotarEstadoAtual({ client, ledgerResult: LEDGER });

    expect(r._tag === 'err' && r.error._tag).toBe('AdocaoRecusada');
    expect(registradas).toHaveLength(1);
  });

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

/**
 * A cadeia real das migrations 75-81 (ordinais 78-84 do ledger), num banco que
 * já registra as 77 anteriores — o estado medido no Staging.
 */
const CONTEUDO = (n: number) => `-- migration ${n}\nselect ${n};`;
const NOMES = [
  [78, '75_arquivamento_de_produto.sql'],
  [79, '76_produto_excluido_no_bling.sql'],
  [80, '77_contato_excluido_no_bling.sql'],
  [81, '78_movimentacao_estoque_somente_por_organizacao.sql'],
  [82, '79_eventos_de_auditoria_do_catalogo.sql'],
  [83, '80_comandos_de_clientes_e_pedidos.sql'],
  [84, '81_revogar_dml_direto_comercial.sql'],
] as const;
const CADEIA = {
  _tag: 'ok' as const,
  value: {
    migrations: [
      { order: 76, path: '../database/73_tentativas_de_conta_a_pagar.sql', sha256: sha(CONTEUDO(76)) },
      { order: 77, path: '../database/74_reconciliacao_de_conta_a_pagar.sql', sha256: sha(CONTEUDO(77)) },
      ...NOMES.map(([order, nome]) => ({ order, path: `../database/${nome}`, sha256: sha(CONTEUDO(order)) })),
    ],
  },
};
/** O disco devolve o conteúdo de cada migration pelo nome; `adulterar` muda um deles. */
function disco(adulterar?: string) {
  return {
    readFileSync: (caminho: string) => {
      const nome = path.basename(caminho);
      const linha = CADEIA.value.migrations.find((m) => path.basename(String(m.path)) === nome)!;
      return nome === adulterar ? `${CONTEUDO(linha.order)} -- editada` : CONTEUDO(linha.order);
    },
  } as never;
}
const JA_APLICADAS = CADEIA.value.migrations.slice(0, 2).map((m) => ({ arquivo: m.path, sha256: m.sha256 }));

async function estadoDe(registradas: Array<{ arquivo: string; sha256: string }>) {
  const r = await estadoDasMigracoes({ client: clienteFalso(registradas), ledgerResult: CADEIA });
  if (r._tag !== 'ok') throw new Error('estado');
  return r.value;
}
function limite(argv: string[]) {
  const r = lerLimite(argv);
  if (r._tag !== 'ok') throw new Error(JSON.stringify(r.error));
  return r.value;
}

describe('limite exato da execução (Marco A / Marco B)', () => {
  it('Marco A: até 80_comandos_de_clientes_e_pedidos.sql aplica 75-80 e deixa a 81 de fora', async () => {
    const estado = await estadoDe([...JA_APLICADAS]);

    const r = planejarAplicacao({ estado, limite: limite(['--ate-arquivo', '80_comandos_de_clientes_e_pedidos.sql']), ledger: CADEIA.value.migrations, fileSystem: disco() });

    expect(r._tag).toBe('ok');
    if (r._tag !== 'ok') return;
    expect(r.value.plano.map((m) => path.basename(String(m.path)))).toEqual(NOMES.slice(0, 6).map(([, n]) => n));
    expect(r.value.posteriores.map((m) => path.basename(String(m.path)))).toEqual(['81_revogar_dml_direto_comercial.sql']);
  });

  it('o mesmo limite pelo ordinal do ledger (83) dá o mesmo plano', async () => {
    const estado = await estadoDe([...JA_APLICADAS]);

    const porNome = planejarAplicacao({ estado, limite: limite(['--ate-arquivo', '80_comandos_de_clientes_e_pedidos.sql']), ledger: CADEIA.value.migrations, fileSystem: disco() });
    const porOrdem = planejarAplicacao({ estado, limite: limite(['--ate-ordem', '83']), ledger: CADEIA.value.migrations, fileSystem: disco() });

    expect(porOrdem).toEqual(porNome);
  });

  it('aplicar o plano do Marco A não executa nem registra a 81', async () => {
    const registradas = [...JA_APLICADAS];
    const client = clienteFalso(registradas);
    const estado = await estadoDe(registradas);
    const plano = planejarAplicacao({ estado, limite: limite(['--ate-arquivo', '80_comandos_de_clientes_e_pedidos.sql']), ledger: CADEIA.value.migrations, fileSystem: disco() });
    if (plano._tag !== 'ok') throw new Error('plano');

    const r = await aplicarPendentes({ client, pendentes: plano.value.plano, fileSystem: disco(), log: () => {} });

    expect(r._tag).toBe('ok');
    expect(registradas.map((x) => path.basename(x.arquivo))).not.toContain('81_revogar_dml_direto_comercial.sql');
    expect(client.executados).not.toContain('-- migration 84');
    expect(registradas).toHaveLength(8);
    expect(client.executados.filter((s) => s === 'commit')).toHaveLength(6);
  });

  it('Marco B: com 75-80 aplicadas, o limite 81 aplica só a 81', async () => {
    const registradas = CADEIA.value.migrations.slice(0, 8).map((m) => ({ arquivo: m.path, sha256: m.sha256 }));
    const estado = await estadoDe(registradas);

    const r = planejarAplicacao({ estado, limite: limite(['--ate-arquivo', '81_revogar_dml_direto_comercial.sql']), ledger: CADEIA.value.migrations, fileSystem: disco() });

    expect(r._tag === 'ok' && r.value.plano.map((m) => path.basename(String(m.path)))).toEqual(['81_revogar_dml_direto_comercial.sql']);
  });

  it('recusa: nome inexistente, número no lugar do nome, os dois limites juntos, limite sem valor', () => {
    expect(lerLimite(['--ate-arquivo', '80'])).toMatchObject({ _tag: 'err', error: { _tag: 'LimiteInvalido' } });
    expect(lerLimite(['--ate-arquivo', 'x.sql', '--ate-ordem', '83'])).toMatchObject({ _tag: 'err', error: { _tag: 'LimiteAmbiguo' } });
    expect(lerLimite(['--ate-ordem'])).toMatchObject({ _tag: 'err', error: { _tag: 'LimiteSemValor' } });
    expect(lerLimite(['--ate-ordem', '0'])).toMatchObject({ _tag: 'err', error: { _tag: 'LimiteInvalido' } });
    expect(lerLimite(['--ate-ordem', '--aplicar'])).toMatchObject({ _tag: 'err', error: { _tag: 'LimiteSemValor' } });
  });

  it('recusa limite que não existe no ledger, ou que já foi aplicado', async () => {
    const estado = await estadoDe([...JA_APLICADAS]);
    const planejar = (argv: string[]) => planejarAplicacao({ estado, limite: limite(argv), ledger: CADEIA.value.migrations, fileSystem: disco() });

    expect(planejar(['--ate-arquivo', '80_comandos_de_cliente.sql'])).toMatchObject({ _tag: 'err', error: { _tag: 'LimiteInexistente' } });
    expect(planejar(['--ate-ordem', '999'])).toMatchObject({ _tag: 'err', error: { _tag: 'LimiteInexistente' } });
    expect(planejar(['--ate-arquivo', '74_reconciliacao_de_conta_a_pagar.sql'])).toMatchObject({ _tag: 'err', error: { _tag: 'LimiteJaAplicado' } });
  });

  it('recusa limite ambíguo: o mesmo nome em duas entradas do ledger', async () => {
    const duplicado = [...CADEIA.value.migrations, { order: 85, path: '../outra/80_comandos_de_clientes_e_pedidos.sql', sha256: 'x' }];
    const estado = await estadoDe([...JA_APLICADAS]);

    expect(planejarAplicacao({ estado, limite: limite(['--ate-arquivo', '80_comandos_de_clientes_e_pedidos.sql']), ledger: duplicado, fileSystem: disco() }))
      .toMatchObject({ _tag: 'err', error: { _tag: 'LimiteAmbiguo' } });
  });

  it('recusa arquivo local que não bate com o checksum do ledger, antes de tocar no banco', async () => {
    const estado = await estadoDe([...JA_APLICADAS]);

    const r = planejarAplicacao({ estado, limite: limite(['--ate-arquivo', '80_comandos_de_clientes_e_pedidos.sql']), ledger: CADEIA.value.migrations, fileSystem: disco('78_movimentacao_estoque_somente_por_organizacao.sql') });

    expect(r).toMatchObject({ _tag: 'err', error: { _tag: 'ChecksumLocalDivergente' } });
  });

  it('recusa sequência inesperada: lacuna (uma posterior aplicada) ou registro desconhecido', async () => {
    const lacuna = await estadoDe([...JA_APLICADAS, { arquivo: CADEIA.value.migrations[4]!.path, sha256: CADEIA.value.migrations[4]!.sha256 }]);
    const estranho = await estadoDe([...JA_APLICADAS, { arquivo: '../database/99_de_outra_historia.sql', sha256: 'x' }]);
    const planejar = (estado: Awaited<ReturnType<typeof estadoDe>>) =>
      planejarAplicacao({ estado, limite: { _tag: 'SemLimite' }, ledger: CADEIA.value.migrations, fileSystem: disco() });

    expect(planejar(lacuna)).toMatchObject({ _tag: 'err', error: { _tag: 'SequenciaInesperada' } });
    expect(planejar(estranho)).toMatchObject({ _tag: 'err', error: { _tag: 'SequenciaInesperada' } });
  });

  it('recusa registro remoto divergente do ledger', async () => {
    const estado = await estadoDe([{ arquivo: CADEIA.value.migrations[0]!.path, sha256: 'OUTRO' }, JA_APLICADAS[1]!]);

    expect(planejarAplicacao({ estado, limite: { _tag: 'SemLimite' }, ledger: CADEIA.value.migrations, fileSystem: disco() }))
      .toMatchObject({ _tag: 'err', error: { _tag: 'RegistroDivergente' } });
  });

  it('arquivo alterado entre a prévia e a aplicação: para antes de executar, nada registrado', async () => {
    const registradas = [...JA_APLICADAS];
    const client = clienteFalso(registradas);
    const plano = CADEIA.value.migrations.slice(2, 4);

    const r = await aplicarPendentes({ client, pendentes: plano, fileSystem: disco('76_produto_excluido_no_bling.sql'), log: () => {} });

    expect(r).toMatchObject({ _tag: 'err', error: { _tag: 'ChecksumLocalDivergente' } });
    expect(registradas).toHaveLength(3);
    expect(client.executados).not.toContain('-- migration 79');
  });

  it('migration registrada por outra execução no meio do caminho: para sem reaplicar', async () => {
    const alvo = CADEIA.value.migrations[2]!;
    const registradas = [...JA_APLICADAS, { arquivo: alvo.path, sha256: alvo.sha256 }];
    const client = clienteFalso(registradas);

    const r = await aplicarPendentes({ client, pendentes: [alvo], fileSystem: disco(), log: () => {} });

    expect(r).toMatchObject({ _tag: 'err', error: { _tag: 'MigracaoJaRegistrada' } });
    expect(client.executados).not.toContain('-- migration 78');
    expect(client.executados).toContain('rollback');
  });

  it('falha do banco no relatório: SQLSTATE e mensagem, nunca o DETAIL com valores de linha', async () => {
    const client = {
      executados: [] as string[],
      query: vi.fn(async (sql: string) => {
        if (sql.startsWith('-- migration')) {
          throw Object.assign(new Error('duplicate key value violates unique constraint "uq_x"'), {
            code: '23505', detail: 'Key (email)=(pessoa@exemplo.com) already exists.',
          });
        }
        return { rows: [] };
      }),
    };

    const r = await aplicarPendentes({ client, pendentes: [CADEIA.value.migrations[2]!], fileSystem: disco(), log: () => {} });

    expect(r._tag).toBe('err');
    expect(JSON.stringify(r)).toContain('23505');
    expect(JSON.stringify(r)).not.toContain('pessoa@exemplo.com');
  });
});

describe('bloqueio 1 — exclusão mútua entre executores', () => {
  it('cada migration: begin → trava de transação → registro relido → SQL → registro → commit', async () => {
    const registradas = [...JA_APLICADAS];
    const client = clienteFalso(registradas);

    await aplicarPendentes({ client, pendentes: [CADEIA.value.migrations[2]!], fileSystem: disco(), log: () => {} });

    const seq = client.executados;
    const i = (trecho: string) => seq.findIndex((x) => x.includes(trecho));
    expect(i('begin')).toBeGreaterThanOrEqual(0);
    expect(i('pg_advisory_xact_lock')).toBeGreaterThan(i('begin'));
    expect(i('select 1 from public.migracoes_aplicadas')).toBeGreaterThan(i('pg_advisory_xact_lock'));
    expect(i('-- migration 78')).toBeGreaterThan(i('select 1 from public.migracoes_aplicadas'));
    expect(i('commit')).toBeGreaterThan(i('-- migration 78'));
    // A trava é de transação (xact): solta no commit/rollback, sem unlock manual.
    expect(seq.some((x) => /pg_advisory_unlock|pg_advisory_lock\(/u.test(x))).toBe(false);
  });
});

describe('bloqueio 2 — relatório sem texto do banco', () => {
  const EMAIL = 'pessoa.sintetica@exemplo.test';

  it('mensagem principal com e-mail sintético: o e-mail não aparece em nenhuma saída', async () => {
    const client = {
      executados: [] as string[],
      query: vi.fn(async (sql: string) => {
        if (sql.startsWith('-- migration')) {
          throw Object.assign(new Error(`duplicate key value violates unique constraint for ${EMAIL}`), {
            code: '23505', detail: `Key (email)=(${EMAIL}) already exists.`, hint: EMAIL, where: EMAIL,
          });
        }
        return { rows: [] };
      }),
    };

    const r = await aplicarPendentes({ client, pendentes: [CADEIA.value.migrations[2]!], fileSystem: disco(), log: () => {} });

    expect(r._tag).toBe('err');
    if (r._tag !== 'err') return;
    const saidas = [JSON.stringify(r), failureMessage(r.error), String(r.error.message)];
    for (const saida of saidas) expect(saida).not.toContain(EMAIL);
    expect(r.error).toMatchObject({ sqlstate: '23505', categoria: 'violacao_de_integridade', arquivo: '../database/75_arquivamento_de_produto.sql' });
    expect(failureMessage(r.error)).toContain('75_arquivamento_de_produto.sql');
    expect(failureMessage(r.error)).toContain('SQLSTATE 23505');
  });

  it('erroReportavel: só SQLSTATE válido e categoria da lista fechada', () => {
    expect(erroReportavel(Object.assign(new Error(EMAIL), { code: '42501' }))).toEqual({ sqlstate: '42501', categoria: 'permissao_insuficiente' });
    expect(erroReportavel(Object.assign(new Error(EMAIL), { code: 'P0001' }))).toEqual({ sqlstate: 'P0001', categoria: 'erro_levantado_pela_migration' });
    expect(erroReportavel(Object.assign(new Error(EMAIL), { code: `${EMAIL}` }))).toEqual({ sqlstate: null, categoria: 'falha_sem_sqlstate' });
    expect(erroReportavel(new Error(EMAIL))).toEqual({ sqlstate: null, categoria: 'falha_sem_sqlstate' });
    expect(JSON.stringify(erroReportavel(Object.assign(new Error(EMAIL), { code: 'ZZ999' })))).not.toContain(EMAIL);
  });
});

describe('bloqueio 3 — opções repetidas ou incompatíveis são recusadas', () => {
  const recusa = (argv: string[], tag: string) => expect(lerOpcoes(argv)).toMatchObject({ _tag: 'err', error: { _tag: tag } });

  it('limite repetido', () => {
    recusa(['--ate-arquivo', '80_comandos_de_clientes_e_pedidos.sql', '--ate-arquivo', '81_revogar_dml_direto_comercial.sql'], 'OpcaoRepetida');
    recusa(['--ate-ordem', '83', '--ate-ordem', '84'], 'OpcaoRepetida');
    // Repetido com o MESMO valor também: a intenção não é inequívoca.
    recusa(['--ate-ordem', '83', '--ate-ordem', '83'], 'OpcaoRepetida');
  });

  it('--adotar com limite, com --aplicar ou com --previa', () => {
    recusa(['--adotar', '--confirmar', '--ate-arquivo', '80_comandos_de_clientes_e_pedidos.sql'], 'CombinacaoIncompativel');
    recusa(['--adotar', '--confirmar', '--ate-ordem', '83'], 'CombinacaoIncompativel');
    recusa(['--adotar', '--aplicar', '--confirmar'], 'CombinacaoIncompativel');
    recusa(['--adotar', '--previa'], 'CombinacaoIncompativel');
  });

  it('o que faria um pedido ser ignorado em silêncio', () => {
    recusa(['--aplicar', '--previa'], 'CombinacaoIncompativel');
    recusa(['--aplicar', '--aplicar', '--confirmar'], 'OpcaoRepetida');
    recusa(['--url', 'postgresql://a', '--url', 'postgresql://b'], 'OpcaoRepetida');
    recusa(['--url'], 'AlvoSemValor');
    recusa(['--ate-limite', '83'], 'OpcaoDesconhecida');
    recusa(['--ate-arquivo=80_comandos_de_clientes_e_pedidos.sql'], 'OpcaoDesconhecida');
    recusa(['--ate-arquivo', '80_comandos_de_clientes_e_pedidos.sql', '81_revogar_dml_direto_comercial.sql'], 'ArgumentoInesperado');
    recusa(['80_comandos_de_clientes_e_pedidos.sql'], 'ArgumentoInesperado');
  });

  it('a combinação válida dos marcos passa', () => {
    expect(lerOpcoes(['--aplicar', '--url', 'postgresql://alvo', '--confirmar', '--ate-arquivo', '80_comandos_de_clientes_e_pedidos.sql']))
      .toMatchObject({ _tag: 'ok', value: { aplicar: true, confirmar: true, adotar: false, previa: false, limite: { _tag: 'Arquivo', nome: '80_comandos_de_clientes_e_pedidos.sql' } } });
  });

  it('a CLI recusa antes de conectar: o alvo nem é tentado', () => {
    // Porta local fechada: se a CLI conectasse, a falha seria de conexão.
    const alvo = 'postgresql://ninguem:segredo@127.0.0.1:9/nada?sslmode=disable';
    for (const [extra, recusa] of [
      [['--aplicar', '--ate-ordem', '83', '--ate-ordem', '84'], '--ate-ordem informada mais de uma vez.'],
      [['--adotar', '--confirmar', '--ate-arquivo', '80_comandos_de_clientes_e_pedidos.sql'], '--adotar marca o ledger inteiro'],
    ] as const) {
      const r = spawnSync(process.execPath, ['scripts/migracoes-remotas.mjs', '--url', alvo, ...extra], { encoding: 'utf8' });
      const saida = `${r.stdout}${r.stderr}`;
      expect(r.status).toBe(1);
      expect(saida).toContain(recusa);
      expect(saida).not.toMatch(/Banco alvo|Falha inesperada|ECONNREFUSED/u);
      expect(saida).not.toContain('segredo');
    }
  });
});
