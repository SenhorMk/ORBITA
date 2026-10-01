import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guarda contra **coluna fantasma**: campo que existe no tipo TypeScript e é
 * gravado no banco, mas não existe na tabela.
 *
 * `Produto` declarava `unidade` e `categoria_id`, e o código gravava as duas —
 * `sync.ts` em todo produto sincronizado, e a rota de produtos quando o
 * usuário escolhia categoria. Nenhuma das duas existia em `produtos`. Cada
 * insert era recusado pelo PostgREST, o laço de paginação capturava a falha
 * por item e só registrava um `console.warn`, e a etapa concluía com **zero
 * produtos**. A sincronização dizia "Sincronizado! 0 produtos" com 17 produtos
 * no Bling, e o erro nunca aparecia em lugar nenhum.
 *
 * O teste lê as colunas declaradas nas migrations — a mesma fonte que produz o
 * banco — e exige que todo campo do tipo tenha coluna correspondente.
 */

const RAIZ = path.resolve(__dirname, '..', '..');

/** Colunas de uma tabela, somando o CREATE TABLE e os ALTER ... ADD COLUMN. */
function colunasDeclaradas(tabela: string): Set<string> {
  const colunas = new Set<string>();
  const dir = path.join(RAIZ, 'database');
  const arquivos = readFileSync(path.join(RAIZ, 'supabase/config.toml'), 'utf8')
    .match(/"\.\.\/database\/[^"]+\.sql"/gu)
    ?.map((m) => m.replace(/"|\.\.\/database\//gu, '')) ?? [];

  const fontes = ['schema_master.sql', ...arquivos];

  for (const arquivo of fontes) {
    let sql: string;
    try {
      sql = readFileSync(path.join(dir, arquivo), 'utf8');
    } catch {
      continue;
    }

    const criacao = new RegExp(
      String.raw`create table (?:if not exists )?(?:public\.)?${tabela}\s*\(([\s\S]*?)\n\);`,
      'iu',
    ).exec(sql);
    if (criacao) {
      for (const linha of criacao[1]!.split('\n')) {
        const nome = /^\s*([a-z_][a-z0-9_]*)\s+[a-z]/iu.exec(linha);
        if (nome && !/^(constraint|primary|unique|foreign|check)$/iu.test(nome[1]!)) {
          colunas.add(nome[1]!.toLowerCase());
        }
      }
    }

    const adicoes = sql.matchAll(
      new RegExp(
        String.raw`alter table (?:public\.)?${tabela}\s+add column (?:if not exists )?([a-z_][a-z0-9_]*)`,
        'giu',
      ),
    );
    for (const adicao of adicoes) colunas.add(adicao[1]!.toLowerCase());
  }

  return colunas;
}

/** Campos declarados numa interface do `src/types/index.ts`. */
function camposDoTipo(nome: string): string[] {
  const fonte = readFileSync(path.join(RAIZ, 'src/types/index.ts'), 'utf8');
  const bloco = new RegExp(String.raw`export interface ${nome} \{([\s\S]*?)\n\}`, 'u').exec(fonte);
  if (!bloco) throw new Error(`interface ${nome} não encontrada`);

  return [...bloco[1]!.matchAll(/^\s{2}([a-z_][a-z0-9_]*)\??:/gimu)].map((m) => m[1]!.toLowerCase());
}

describe('o tipo Produto não pode declarar coluna que a tabela não tem', () => {
  const colunas = colunasDeclaradas('produtos');

  it('as migrations realmente declaram a tabela produtos', () => {
    expect(colunas.has('bling_id')).toBe(true);
    expect(colunas.has('organizacao_id')).toBe(true);
  });

  it('unidade existe — a ausência dela zerava toda sincronização de catálogo', () => {
    expect(colunas.has('unidade')).toBe(true);
  });

  it('categoria_id existe — a rota de produtos grava esse campo', () => {
    expect(colunas.has('categoria_id')).toBe(true);
  });

  it('imagem_storage_path existe — a foto do ORBITA não pode morar em imagem_url, que o Bling regrava', () => {
    expect(colunas.has('imagem_storage_path')).toBe(true);
    expect(colunas.has('imagem_url')).toBe(true);
    expect(camposDoTipo('Produto')).toEqual(expect.arrayContaining(['imagem_url', 'imagem_storage_path']));
  });

  it('todo campo do tipo Produto tem coluna correspondente', () => {
    const semColuna = camposDoTipo('Produto').filter((campo) => !colunas.has(campo));

    expect(
      semColuna,
      `Campos do tipo Produto sem coluna em produtos: ${semColuna.join(', ')}. `
        + 'O PostgREST recusa o insert inteiro, e a sincronização engole a recusa por item.',
    ).toEqual([]);
  });
});

describe('o tipo Cliente não pode declarar coluna que a tabela não tem', () => {
  const colunas = colunasDeclaradas('clientes');

  it('todo campo do tipo Cliente tem coluna correspondente', () => {
    const semColuna = camposDoTipo('Cliente').filter((campo) => !colunas.has(campo));

    expect(semColuna, `Campos do tipo Cliente sem coluna em clientes: ${semColuna.join(', ')}`).toEqual([]);
  });
});
