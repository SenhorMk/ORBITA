import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Os workers (infra/worker/Dockerfile) são compilados por `tsc -p scripts/tsconfig.worker.json`,
 * que não reescreve o alias `@/`: um import de VALOR com `@/` vira `require("@/...")` e o
 * container morre ao iniciar (MODULE_NOT_FOUND). Imports só de tipo são apagados e podem ficar.
 * Este teste percorre o grafo de imports relativos a partir de cada entrypoint do worker.
 */
const raiz = path.resolve(__dirname, '..');
const tsconfigWorker = JSON.parse(fs.readFileSync(path.join(raiz, 'scripts/tsconfig.worker.json'), 'utf8')) as {
  include: string[];
};
const entrypoints = tsconfigWorker.include.map((arquivo) => path.join(raiz, 'scripts', arquivo));

function resolverRelativo(de: string, especificador: string): string | null {
  const base = path.resolve(path.dirname(de), especificador);
  for (const candidato of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidato) && fs.statSync(candidato).isFile()) return candidato;
  }
  return null;
}

/** Especificadores importados como valor (sobrevivem à compilação). */
function importsDeValor(arquivo: string): string[] {
  const fonte = ts.createSourceFile(arquivo, fs.readFileSync(arquivo, 'utf8'), ts.ScriptTarget.Latest, true);
  const saida: string[] = [];
  const visitar = (no: ts.Node): void => {
    if (ts.isImportDeclaration(no) && ts.isStringLiteral(no.moduleSpecifier)) {
      const clausula = no.importClause;
      const soTipo = clausula !== undefined && (clausula.isTypeOnly || (
        clausula.name === undefined && clausula.namedBindings !== undefined
        && ts.isNamedImports(clausula.namedBindings)
        && clausula.namedBindings.elements.length > 0
        && clausula.namedBindings.elements.every((e) => e.isTypeOnly)));
      if (!soTipo) saida.push(no.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(no) && no.moduleSpecifier && ts.isStringLiteral(no.moduleSpecifier) && !no.isTypeOnly) {
      saida.push(no.moduleSpecifier.text);
    } else if (ts.isCallExpression(no) && no.arguments.length === 1 && ts.isStringLiteral(no.arguments[0])
      && (no.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(no.expression) && no.expression.text === 'require'))) {
      saida.push(no.arguments[0].text);
    }
    ts.forEachChild(no, visitar);
  };
  visitar(fonte);
  return saida;
}

function percorrer(): { visitados: number; violacoes: string[] } {
  const visitados = new Set<string>();
  const violacoes: string[] = [];
  const pilha = [...entrypoints];
  while (pilha.length > 0) {
    const atual = pilha.pop() as string;
    if (visitados.has(atual)) continue;
    visitados.add(atual);
    for (const especificador of importsDeValor(atual)) {
      if (especificador.startsWith('@/')) {
        violacoes.push(`${path.relative(raiz, atual).replaceAll('\\', '/')} -> ${especificador}`);
      } else if (especificador.startsWith('.')) {
        const alvo = resolverRelativo(atual, especificador);
        if (alvo) pilha.push(alvo);
      }
    }
  }
  return { visitados: visitados.size, violacoes };
}

describe('grafo de imports dos workers', () => {
  it('todo entrypoint listado em scripts/tsconfig.worker.json existe', () => {
    for (const entrypoint of entrypoints) expect(fs.existsSync(entrypoint), entrypoint).toBe(true);
  });

  it('nenhum import de valor com o alias @/ (tsc não o reescreve e o container não inicia)', () => {
    const { visitados, violacoes } = percorrer();
    expect(visitados).toBeGreaterThan(entrypoints.length);
    expect(violacoes).toEqual([]);
  });

  it('o detector reconhece import de valor e ignora import só de tipo', () => {
    const tmp = path.join(raiz, 'scripts', '.tmp-worker-imports-amostra.ts');
    fs.writeFileSync(tmp, [
      "import type { A } from '@/so/tipo';",
      "import { type B } from '@/so/tipo-nomeado';",
      "import { C, type D } from '@/valor/misto';",
      "export * from '@/valor/reexporta';",
    ].join('\n'));
    try {
      expect(importsDeValor(tmp)).toEqual(['@/valor/misto', '@/valor/reexporta']);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });
});
