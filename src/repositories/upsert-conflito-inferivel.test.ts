import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guarda contra **alvo de conflito não inferível**: um `onConflict` que aponta
 * para colunas cujo índice único é PARCIAL, ou que não existe.
 *
 * O PostgREST traduz `upsert(payload, { onConflict: 'organizacao_id, bling_id' })`
 * para `ON CONFLICT (organizacao_id, bling_id) DO UPDATE ...` — sem `WHERE`,
 * porque a API não tem como expressar um. O PostgreSQL só infere um índice
 * parcial quando a própria instrução repete o predicado do índice. Resultado:
 *
 *   42P10: there is no unique or exclusion constraint matching the ON CONFLICT
 *          specification
 *
 * Os índices `(organizacao_id, bling_id)` nasceram parciais na migration 22, e
 * com isso TODO upsert com escopo de organização falhava — clientes, produtos,
 * pedidos, notas, financeiro e o próprio `sync_state`. A migration 55 os
 * tornou totais. Este teste existe para que o par não volte a se separar: ele
 * lê os dois lados da fronteira — o `onConflict` do TypeScript e os índices
 * declarados nas migrations — e exige que combinem.
 */

const RAIZ = path.resolve(__dirname, '..', '..');

/** Um alvo de `ON CONFLICT` encontrado no código da aplicação. */
interface AlvoDeConflito {
  arquivo: string;
  tabela: string;
  colunas: string[];
}

/** Um índice/constraint único declarado nas migrations. */
interface UnicoDeclarado {
  tabela: string;
  colunas: string[];
  parcial: boolean;
}

function normalizarColunas(lista: string): string[] {
  return lista
    .split(',')
    .map((c) => c.trim().replace(/^"|"$/gu, '').toLowerCase())
    .filter((c) => c.length > 0);
}

function arquivosTypeScript(dir: string): string[] {
  const encontrados: string[] = [];
  for (const entrada of readdirSync(dir)) {
    const completo = path.join(dir, entrada);
    if (statSync(completo).isDirectory()) {
      encontrados.push(...arquivosTypeScript(completo));
    } else if (/\.tsx?$/u.test(entrada) && !/\.test\.tsx?$/u.test(entrada)) {
      encontrados.push(completo);
    }
  }
  return encontrados;
}

/**
 * Todo `onConflict` do código, com a tabela a que pertence.
 *
 * A tabela é o `.from('...')` mais próximo ACIMA do `onConflict` — é assim que
 * a cadeia do supabase-js se lê, e cobre tanto a forma encadeada numa linha só
 * quanto a forma quebrada em várias linhas com o payload no meio.
 */
function alvosDeConflitoNoCodigo(): AlvoDeConflito[] {
  const alvos: AlvoDeConflito[] = [];

  for (const arquivo of arquivosTypeScript(path.join(RAIZ, 'src'))) {
    const fonte = readFileSync(arquivo, 'utf8');
    const relativo = path.relative(RAIZ, arquivo).replace(/\\/gu, '/');

    for (const ocorrencia of fonte.matchAll(/onConflict:\s*'([^']+)'/gu)) {
      const antes = fonte.slice(0, ocorrencia.index);
      const from = [...antes.matchAll(/\.from\(\s*'([a-z_][a-z0-9_]*)'/gu)].pop();
      if (!from) continue;

      alvos.push({
        arquivo: relativo,
        tabela: from[1]!.toLowerCase(),
        colunas: normalizarColunas(ocorrencia[1]!),
      });
    }
  }

  return alvos;
}

/**
 * Índices e constraints únicos declarados nas migrations, na ordem em que o
 * banco os aplica.
 *
 * A ordem importa: a migration 55 derruba e recria índices que a 22 criou
 * parciais. Vence a última declaração de cada nome, exatamente como no banco.
 */
function unicosDeclarados(): UnicoDeclarado[] {
  const dir = path.join(RAIZ, 'database');
  const ordem = readFileSync(path.join(RAIZ, 'supabase/config.toml'), 'utf8')
    .match(/"\.\.\/database\/[^"]+\.sql"/gu)
    ?.map((m) => m.replace(/"|\.\.\/database\//gu, '')) ?? [];

  const porNome = new Map<string, UnicoDeclarado>();
  const semNome: UnicoDeclarado[] = [];

  for (const arquivo of ['schema_master.sql', ...ordem]) {
    let sql: string;
    try {
      // Sem os comentários: a própria migration 55 CITA o índice parcial
      // antigo no cabeçalho para explicar o defeito, e ler a citação como se
      // fosse DDL faria a guarda acreditar num índice que não existe.
      sql = readFileSync(path.join(dir, arquivo), 'utf8').replace(/^\s*--.*$/gmu, '');
    } catch {
      continue;
    }

    // create [unique] index [if not exists] nome on [public.]tabela (cols) [where ...];
    //
    // Vence a última criação de cada nome. A migration 55 derruba e recria os
    // índices que a 22 criou parciais, no mesmo arquivo e nessa ordem — ler só
    // os `create`, mantendo o último, reproduz o estado final do banco.
    for (const idx of sql.matchAll(
      /create\s+unique\s+index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?([a-z_][a-z0-9_]*)\s+on\s+(?:public\.)?([a-z_][a-z0-9_]*)\s*\(([^)]*)\)([^;]*);/giu,
    )) {
      porNome.set(idx[1]!.toLowerCase(), {
        tabela: idx[2]!.toLowerCase(),
        colunas: normalizarColunas(idx[3]!),
        parcial: /\bwhere\b/iu.test(idx[4]!),
      });
    }

    // alter table [public.]tabela add constraint nome unique (cols);
    for (const alter of sql.matchAll(
      /alter\s+table\s+(?:public\.)?([a-z_][a-z0-9_]*)\s+add\s+constraint\s+([a-z_][a-z0-9_]*)\s+unique\s*\(([^)]*)\)/giu,
    )) {
      porNome.set(alter[2]!.toLowerCase(), {
        tabela: alter[1]!.toLowerCase(),
        colunas: normalizarColunas(alter[3]!),
        parcial: false,
      });
    }

    // create table tabela ( ... constraint nome unique (cols) ... primary key (cols) ... )
    for (const tabela of sql.matchAll(
      /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([a-z_][a-z0-9_]*)\s*\(([\s\S]*?)\n\);/giu,
    )) {
      const nome = tabela[1]!.toLowerCase();
      const corpo = tabela[2]!;

      for (const restricao of corpo.matchAll(
        /constraint\s+([a-z_][a-z0-9_]*)\s+unique\s*\(([^)]*)\)/giu,
      )) {
        porNome.set(restricao[1]!.toLowerCase(), {
          tabela: nome,
          colunas: normalizarColunas(restricao[2]!),
          parcial: false,
        });
      }

      for (const pk of corpo.matchAll(/(?:^|,)\s*primary\s+key\s*\(([^)]*)\)/giu)) {
        semNome.push({ tabela: nome, colunas: normalizarColunas(pk[1]!), parcial: false });
      }

      for (const pkColuna of corpo.matchAll(/^\s*([a-z_][a-z0-9_]*)\s+[a-z].*\bprimary\s+key\b/gimu)) {
        semNome.push({ tabela: nome, colunas: [pkColuna[1]!.toLowerCase()], parcial: false });
      }
    }
  }

  return [...porNome.values(), ...semNome];
}

const mesmasColunas = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((coluna, i) => coluna === b[i]);

describe('todo onConflict tem um índice único que o PostgreSQL consegue inferir', () => {
  const alvos = alvosDeConflitoNoCodigo();
  const unicos = unicosDeclarados();

  it('o teste realmente encontrou os dois lados da fronteira', () => {
    expect(alvos.length).toBeGreaterThan(5);
    expect(unicos.length).toBeGreaterThan(20);
  });

  it('o upsert de clientes — o que falhava em produção — está coberto', () => {
    const cliente = alvos.find((a) => a.tabela === 'clientes');
    expect(cliente?.colunas).toEqual(['organizacao_id', 'bling_id']);

    const indice = unicos.find(
      (u) => u.tabela === 'clientes' && mesmasColunas(u.colunas, ['organizacao_id', 'bling_id']),
    );
    expect(indice, 'uq_clientes_org_bling não foi encontrado nas migrations').toBeDefined();
    expect(
      indice!.parcial,
      'o índice de clientes é parcial: o ON CONFLICT sem WHERE que o PostgREST gera falha com 42P10',
    ).toBe(false);
  });

  it.each(alvos.map((a) => [`${a.arquivo} → ${a.tabela}(${a.colunas.join(', ')})`, a] as const))(
    '%s',
    (_rotulo, alvo) => {
      const candidatos = unicos.filter(
        (u) => u.tabela === alvo.tabela && mesmasColunas(u.colunas, alvo.colunas),
      );

      expect(
        candidatos.length,
        `Nenhum índice único em ${alvo.tabela}(${alvo.colunas.join(', ')}). `
          + 'O PostgREST emite ON CONFLICT com essas colunas e o Postgres responde 42P10.',
      ).toBeGreaterThan(0);

      expect(
        candidatos.some((u) => !u.parcial),
        `O único índice em ${alvo.tabela}(${alvo.colunas.join(', ')}) é PARCIAL. `
          + 'O PostgREST não emite o predicado, então a inferência não o encontra e o upsert morre com 42P10.',
      ).toBe(true);
    },
  );
});
