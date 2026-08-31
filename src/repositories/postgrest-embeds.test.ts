import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guarda contra **embed ambíguo do PostgREST**.
 *
 * Quando existe mais de uma chave estrangeira entre duas tabelas, o PostgREST
 * recusa a consulta inteira em vez de escolher uma:
 *
 *   PGRST201 — Could not embed because more than one relationship was found
 *
 * As migrations de tenancy criaram, em cima de cada FK simples, uma segunda FK
 * composta com `organizacao_id`. Nove pares de tabelas ficaram ambíguos de uma
 * vez, e ninguém percebeu porque o erro vem no campo `error` da resposta — não
 * é lançado — e o código o ignorava.
 *
 * O efeito foi total e invisível: `pedidos` deixou de ser lido, o painel
 * mostrava "R$ 0,00" e "0 pedidos" com pedidos gravados no banco, e a resposta
 * HTTP era 200. Reproduzido contra um PostgREST real em 2026-08-31.
 *
 * Este teste lê os dois lados: os embeds que o código escreve e as chaves
 * estrangeiras que as migrations declaram. Um embed sem desambiguação, num par
 * que tem mais de uma FK, falha aqui — no commit.
 */

const RAIZ = path.resolve(__dirname, '..', '..');

/** Uma relação `origem -> destino` declarada por uma FK nas migrations. */
interface Relacao {
  readonly origem: string;
  readonly destino: string;
  readonly constraint: string;
}

function arquivosTypeScript(dir: string): string[] {
  const encontrados: string[] = [];
  for (const entrada of readdirSync(dir)) {
    const completo = path.join(dir, entrada);
    if (statSync(completo).isDirectory()) encontrados.push(...arquivosTypeScript(completo));
    else if (/\.tsx?$/u.test(entrada) && !/\.test\.tsx?$/u.test(entrada)) encontrados.push(completo);
  }
  return encontrados;
}

/** Todas as chaves estrangeiras declaradas nas migrations, sem comentários. */
export function relacoesDeclaradas(): Relacao[] {
  const dir = path.join(RAIZ, 'database');
  const ordem = readFileSync(path.join(RAIZ, 'supabase/config.toml'), 'utf8')
    .match(/"\.\.\/database\/[^"]+\.sql"/gu)
    ?.map((m) => m.replace(/"|\.\.\/database\//gu, '')) ?? [];

  const porNome = new Map<string, Relacao>();

  for (const arquivo of ['schema_master.sql', ...ordem]) {
    let sql: string;
    try {
      sql = readFileSync(path.join(dir, arquivo), 'utf8').replace(/^\s*--.*$/gmu, '');
    } catch {
      continue;
    }

    // alter table X add constraint N foreign key (...) references Y(...)
    for (const m of sql.matchAll(
      /alter\s+table\s+(?:public\.)?([a-z_][a-z0-9_]*)[\s\S]{0,80}?add\s+constraint\s+([a-z_][a-z0-9_]*)\s+foreign\s+key\s*\([^)]*\)\s*references\s+(?:public\.)?([a-z_][a-z0-9_]*)/giu,
    )) {
      porNome.set(m[2]!.toLowerCase(), {
        origem: m[1]!.toLowerCase(),
        destino: m[3]!.toLowerCase(),
        constraint: m[2]!.toLowerCase(),
      });
    }

    // constraint N foreign key (...) references Y(...) dentro de create table
    for (const tabela of sql.matchAll(
      /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([a-z_][a-z0-9_]*)\s*\(([\s\S]*?)\n\);/giu,
    )) {
      const origem = tabela[1]!.toLowerCase();
      for (const m of tabela[2]!.matchAll(
        /constraint\s+([a-z_][a-z0-9_]*)\s+foreign\s+key\s*\([^)]*\)\s*references\s+(?:public\.)?([a-z_][a-z0-9_]*)/giu,
      )) {
        porNome.set(m[1]!.toLowerCase(), {
          origem,
          destino: m[2]!.toLowerCase(),
          constraint: m[1]!.toLowerCase(),
        });
      }
      // coluna com `references Y(...)` inline gera FK com nome automático
      for (const m of tabela[2]!.matchAll(
        /^\s*([a-z_][a-z0-9_]*)\s+[a-z][a-z0-9_() ]*\s+references\s+(?:public\.)?([a-z_][a-z0-9_]*)/gimu,
      )) {
        const destino = m[2]!.toLowerCase();
        if (destino === 'users') continue; // auth.users não é exposto no PostgREST
        porNome.set(`${origem}_${m[1]!.toLowerCase()}_fkey`, {
          origem,
          destino,
          constraint: `${origem}_${m[1]!.toLowerCase()}_fkey`,
        });
      }
    }
  }

  return [...porNome.values()];
}

/** Quantas FKs ligam `origem` a `destino`. Mais de uma = embed ambíguo. */
export function contarRelacoes(relacoes: Relacao[], origem: string, destino: string): number {
  return relacoes.filter((r) => r.origem === origem && r.destino === destino).length;
}

/** Um embed escrito no código: tabela base, tabela embutida, desambiguação. */
interface Embed {
  readonly arquivo: string;
  readonly base: string;
  readonly embutida: string;
  readonly desambiguada: boolean;
}

/**
 * Todo embed que o código escreve, com a tabela base do `.from(...)` anterior.
 *
 * Reconhece as duas formas: `nfe:documentos_fiscais(*)` e a desambiguada
 * `nfe:documentos_fiscais!nome_da_constraint(*)`.
 */
export function embedsNoCodigo(): Embed[] {
  const embeds: Embed[] = [];

  // Só o texto DENTRO de `.select('...')` ou `.select(`...`)`. Procurar o
  // padrão `alias:tabela(` na fonte inteira casava com chamada de função e
  // literal de objeto, e enchia a guarda de falso positivo.
  const SELECT = /\.select\(\s*(['"`])([\s\S]*?)\1/gu;
  const EMBED = /([a-z_][a-z0-9_]*)\s*:\s*([a-z_][a-z0-9_]*)(![a-z_][a-z0-9_]*)?\s*\(/giu;

  for (const arquivo of arquivosTypeScript(path.join(RAIZ, 'src'))) {
    const fonte = readFileSync(arquivo, 'utf8');
    const relativo = path.relative(RAIZ, arquivo).replace(/\\/gu, '/');

    for (const chamada of fonte.matchAll(SELECT)) {
      const antes = fonte.slice(0, chamada.index);
      const from = [...antes.matchAll(/\.from\(\s*'([a-z_][a-z0-9_]*)'/gu)].pop();
      if (!from) continue;

      for (const m of chamada[2]!.matchAll(EMBED)) {
        embeds.push({
          arquivo: relativo,
          base: from[1]!.toLowerCase(),
          embutida: m[2]!.toLowerCase(),
          desambiguada: m[3] !== undefined,
        });
      }
    }
  }

  return embeds;
}

describe('nenhum embed do PostgREST pode ser ambíguo', () => {
  const relacoes = relacoesDeclaradas();
  const embeds = embedsNoCodigo();

  it('o teste enxerga os dois lados da fronteira', () => {
    expect(relacoes.length).toBeGreaterThan(20);
    expect(embeds.length).toBeGreaterThan(0);
  });

  it('as migrations realmente declaram as duas FKs que quebraram o painel', () => {
    // Se um dia sobrar só uma, o embed deixa de precisar de desambiguação —
    // mas até lá é esta duplicidade que torna a guarda necessária.
    expect(contarRelacoes(relacoes, 'documentos_fiscais', 'pedidos')).toBeGreaterThan(1);
  });

  it('o embed de nota fiscal em pedidos está desambiguado', () => {
    const nfe = embeds.find((e) => e.base === 'pedidos' && e.embutida === 'documentos_fiscais');
    expect(nfe, 'o embed de documentos_fiscais em pedidos sumiu do código').toBeDefined();
    expect(
      nfe!.desambiguada,
      'sem `!nome_da_constraint` o PostgREST responde PGRST201 e a leitura de pedidos inteira falha',
    ).toBe(true);
  });

  it.each(embeds.map((e) => [`${e.arquivo}: ${e.base} → ${e.embutida}`, e] as const))(
    '%s',
    (_rotulo, embed) => {
      // O PostgREST aceita FK nos dois sentidos para embutir.
      const caminhos = contarRelacoes(relacoes, embed.embutida, embed.base)
        + contarRelacoes(relacoes, embed.base, embed.embutida);

      if (caminhos > 1) {
        expect(
          embed.desambiguada,
          `${embed.base} e ${embed.embutida} têm ${caminhos} chaves estrangeiras entre si. `
            + 'Sem `!nome_da_constraint` o PostgREST recusa a consulta inteira com PGRST201 — '
            + 'e o erro vem no campo `error`, não é lançado, então some fácil.',
        ).toBe(true);
      }
    },
  );
});
