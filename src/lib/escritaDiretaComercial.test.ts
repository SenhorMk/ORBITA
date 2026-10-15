import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * PRE-006A: o inventário da escrita direta em catálogo, clientes, pedidos e
 * estoque (`docs/security/inventario-escrita-direta-comercial.md`) como regra.
 *
 * O navegador fala com o Supabase pela chave anônima e a sessão do usuário:
 * tudo o que ele grava passa só por RLS e grants. Hoje nenhum arquivo do
 * navegador grava nas seis tabelas — todas as mutações passam por rotas do
 * servidor com escopo verificado. Este teste impede que um caller novo
 * apareça sem entrar no inventário (e sem um comando do servidor).
 */

const TABELAS = ['produtos', 'categorias', 'movimentacao_estoque', 'clientes', 'pedidos', 'itens_pedido'] as const;

/** Leituras diretas do navegador inventariadas (arquivo → tabelas). Mudou? Atualize o inventário. */
const LEITURAS_DO_NAVEGADOR: Record<string, readonly string[]> = {
  // Itens do pedido selecionado, com `produtos` embutido (`produto:produtos!fk_item_produto(*)`).
  'src/app/page.tsx': ['itens_pedido'],
  'src/components/ManualOrderModal.tsx': ['clientes', 'produtos'],
};

const RAIZ = path.resolve(__dirname, '..', '..');

function arquivos(dir: string): string[] {
  return readdirSync(dir).flatMap((nome) => {
    const caminho = path.join(dir, nome);
    if (statSync(caminho).isDirectory()) return nome === 'e2e' ? [] : arquivos(caminho);
    return /\.(ts|tsx)$/.test(nome) && !/\.test\.tsx?$/.test(nome) ? [caminho] : [];
  });
}

/** Do navegador: componente cliente ou quem importa o cliente Supabase do navegador. */
function doNavegador(fonte: string): boolean {
  return /^\s*['"]use client['"]/m.test(fonte) || /lib\/supabaseClient['"]/.test(fonte);
}

/** Cada `.from('<tabela>')` do escopo com a cadeia até o próximo `;`. */
function acessos(fonte: string): Array<{ tabela: string; cadeia: string }> {
  const encontrados: Array<{ tabela: string; cadeia: string }> = [];
  for (const m of fonte.matchAll(/\.from\(\s*['"]([a-z_]+)['"]\s*\)/g)) {
    const tabela = m[1]!;
    if (!(TABELAS as readonly string[]).includes(tabela)) continue;
    const resto = fonte.slice((m.index ?? 0) + m[0].length);
    const fim = resto.indexOf(';');
    encontrados.push({ tabela, cadeia: fim >= 0 ? resto.slice(0, fim) : resto });
  }
  return encontrados;
}

const navegador = arquivos(path.join(RAIZ, 'src'))
  .map((caminho) => ({ caminho: path.relative(RAIZ, caminho).split(path.sep).join('/'), fonte: readFileSync(caminho, 'utf8') }))
  .filter(({ fonte }) => doNavegador(fonte));

describe('escrita direta comercial pelo navegador (PRE-006A)', () => {
  it('o inventário enxerga os arquivos do navegador (o detector não está cego)', () => {
    expect(navegador.map((a) => a.caminho)).toContain('src/components/ManualOrderModal.tsx');
  });

  it('nenhum arquivo do navegador grava nas seis tabelas', () => {
    const escritas = navegador.flatMap(({ caminho, fonte }) => acessos(fonte)
      .filter(({ cadeia }) => /\.(insert|update|upsert|delete)\(/.test(cadeia))
      .map(({ tabela }) => `${caminho} → ${tabela}`));
    expect(escritas).toEqual([]);
  });

  it('nenhum arquivo do navegador chama RPC do banco', () => {
    const rpcs = navegador.filter(({ fonte }) => /\bsupabase\s*\.\s*rpc\(/.test(fonte)).map(({ caminho }) => caminho);
    expect(rpcs).toEqual([]);
  });

  it('as leituras diretas do navegador são exatamente as inventariadas', () => {
    const leituras: Record<string, string[]> = {};
    for (const { caminho, fonte } of navegador) {
      const tabelas = [...new Set(acessos(fonte).map((a) => a.tabela))].sort();
      if (tabelas.length > 0) leituras[caminho] = tabelas;
    }
    expect(leituras).toEqual(LEITURAS_DO_NAVEGADOR);
  });
});
