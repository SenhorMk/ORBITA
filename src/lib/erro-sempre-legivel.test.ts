import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { descreverErro } from './erroLegivel';

/**
 * Guarda contra **erro que apaga a própria causa**.
 *
 * O padrão `err instanceof Error ? err.message : String(err)` parece defensivo
 * e é o contrário disso. O que o `supabase-js` lança num upsert recusado não é
 * um `Error` — é um `PostgrestError`, objeto simples com `message`, `code`,
 * `details` e `hint`. `String()` de um objeto simples é `[object Object]`,
 * então o ramo do `else` descarta exatamente a informação que importa.
 *
 * Foi assim que "42P10: there is no unique or exclusion constraint matching the
 * ON CONFLICT specification" chegou ao log como `Primeira falha: [object
 * Object]`, quatro vezes seguidas, sem apontar para lugar nenhum.
 *
 * `descreverErro` preserva código, mensagem, detalhes e dica. Esta guarda
 * existe para a migração grudar: sem ela, o padrão volta no próximo `catch`
 * escrito por hábito.
 */

const RAIZ = path.resolve(__dirname, '..', '..');

/**
 * Arquivos isentos, e por quê.
 *
 * `erroLegivel.ts` cita o padrão na documentação, que é onde ele deve aparecer:
 * o texto explica o defeito. Esta própria guarda também o cita, para provar que
 * o detector funciona.
 */
const ISENTOS = new Set([
  'src/lib/erroLegivel.ts',
  'src/lib/erro-sempre-legivel.test.ts',
]);

/** O padrão exato que descarta a causa quando o erro não é um `Error`. */
const PADRAO_CRU = /(\b[A-Za-z_$][\w$]*) instanceof Error \? \1\.message : String\(\1\)/gu;

function arquivosDeCodigo(dir: string): string[] {
  const encontrados: string[] = [];
  for (const entrada of readdirSync(dir)) {
    const completo = path.join(dir, entrada);
    if (statSync(completo).isDirectory()) {
      encontrados.push(...arquivosDeCodigo(completo));
    } else if (/\.tsx?$/u.test(entrada)) {
      encontrados.push(completo);
    }
  }
  return encontrados;
}

/** Pontos que ainda descartam a causa do erro, com arquivo e linha. */
export function pontosCrus(): string[] {
  const pontos: string[] = [];
  for (const arquivo of arquivosDeCodigo(path.join(RAIZ, 'src'))) {
    const relativo = path.relative(RAIZ, arquivo).replace(/\\/gu, '/');
    if (ISENTOS.has(relativo)) continue;

    const linhas = readFileSync(arquivo, 'utf8').split('\n');
    linhas.forEach((linha, i) => {
      PADRAO_CRU.lastIndex = 0;
      if (PADRAO_CRU.test(linha)) pontos.push(`${relativo}:${i + 1}`);
    });
  }
  return pontos;
}

describe('o erro do servidor chega legível', () => {
  it('o detector reconhece o padrão — prova negativa da guarda', () => {
    // Se esta expectativa quebrar, a guarda passou a aprovar tudo por engano e
    // o resultado verde do caso seguinte não vale nada.
    const amostra = 'const msg = err instanceof Error ? err.message : String(err);';
    PADRAO_CRU.lastIndex = 0;
    expect(PADRAO_CRU.test(amostra)).toBe(true);

    // E não confunde uma variável com outra: o ramo do `else` tem de descartar
    // a MESMA variável que o `instanceof` testou.
    PADRAO_CRU.lastIndex = 0;
    expect(PADRAO_CRU.test('a instanceof Error ? a.message : String(b)')).toBe(false);
  });

  it('a varredura enxerga o código de verdade', () => {
    // Sem isto, um erro de caminho faria a guarda passar varrendo zero arquivo.
    const arquivos = arquivosDeCodigo(path.join(RAIZ, 'src'));
    expect(arquivos.length).toBeGreaterThan(100);
    expect(readFileSync(path.join(RAIZ, 'src/services/bling.ts'), 'utf8')).toContain('descreverErro');
  });

  it('nenhum ponto do código descarta a causa do erro', () => {
    expect(
      pontosCrus(),
      'O que o supabase-js lança não é um Error: String() dele é "[object Object]", '
        + 'e o código SQL some junto. Use `descreverErro` de `lib/erroLegivel`.',
    ).toEqual([]);
  });

  it('preserva código, mensagem, detalhes e dica de um erro do PostgREST', () => {
    const erro = {
      code: '42P10',
      message: 'there is no unique or exclusion constraint matching the ON CONFLICT specification',
      details: 'produtos',
      hint: 'crie um índice único total',
    };

    const descrito = descreverErro(erro);

    expect(descrito).toContain('42P10');
    expect(descrito).toContain('ON CONFLICT');
    expect(descrito).toContain('produtos');
    expect(descrito).toContain('crie um índice único total');
    expect(descrito).not.toContain('[object Object]');
  });

  it('não vaza token, chave nem segredo no último recurso', () => {
    // Objeto sem message/code/details/hint cai no JSON.stringify. Vários dos
    // pontos migrados terminam numa tela, então isto tem de ser verdade.
    const erro = {
      status: 500,
      access_token: 'ya29.token-real',
      client_secret: 'segredo-do-app',
      contexto: { password: 'senha', authorization: 'Bearer abc' },
    };

    const descrito = descreverErro(erro);

    expect(descrito).not.toContain('ya29.token-real');
    expect(descrito).not.toContain('segredo-do-app');
    expect(descrito).not.toContain('senha');
    expect(descrito).not.toContain('Bearer abc');
    expect(descrito).toContain('[REDACTED]');
    // O que não é segredo continua visível: redigir não pode virar apagar.
    expect(descrito).toContain('500');
  });
});
