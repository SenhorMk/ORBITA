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
 *
 * Desde o PRE-006D (migration 81) o banco também recusa: `authenticated` não
 * tem mais INSERT/UPDATE/DELETE nas seis tabelas. Um caller novo do navegador
 * falharia em produção com 42501; este teste o barra antes, no commit.
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

/**
 * Do navegador: componente cliente ou quem importa o cliente Supabase do
 * navegador — por alias ou caminho relativo (`./supabaseClient`), que a
 * versão do PRE-006A não enxergava.
 */
export function doNavegador(fonte: string): boolean {
  return /^\s*['"]use client['"]/m.test(fonte) || /[/'"]supabaseClient['"]/.test(fonte);
}

/**
 * Executa como o usuário, com a chave anônima e o token dele: passa por RLS e
 * pelos grants de `authenticated`, como o navegador. Hoje só as rotas de
 * organização e convite o usam.
 */
export function comSessaoDoUsuario(fonte: string): boolean {
  return /\bcreateActorScopedSupabaseClient\b/.test(fonte);
}

/**
 * `.from(<expressão>)` direto no cliente do banco: a tabela não é literal e o
 * inventário não sabe qual é. `supabase.storage.from(...)` é Storage, e fica
 * de fora.
 */
export function fromNaoLiteral(fonte: string): boolean {
  return /\b(?:supabase|client|cliente)\s*\.\s*from\(\s*[^'"\s)]/.test(fonte);
}

/** Cada `.from('<tabela>')` do escopo com a cadeia até o próximo `;`. */
export function acessos(fonte: string): Array<{ tabela: string; cadeia: string }> {
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

const fontes = arquivos(path.join(RAIZ, 'src'))
  .map((caminho) => ({ caminho: path.relative(RAIZ, caminho).split(path.sep).join('/'), fonte: readFileSync(caminho, 'utf8') }));
const navegador = fontes.filter(({ fonte }) => doNavegador(fonte));

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

/**
 * PRE-006B: catálogo e estoque preparados para o PRE-006D, que revoga o DML de
 * `authenticated`. Além do navegador, nenhuma rota pode depender desse grant:
 * quem executa como o usuário não toca as seis tabelas.
 */
describe('nenhum caminho com a sessão do usuário depende do DML de authenticated (PRE-006B)', () => {
  it('o detector reconhece o cliente com a sessão do usuário (não está cego)', () => {
    expect(fontes.filter(({ fonte }) => comSessaoDoUsuario(fonte)).map((a) => a.caminho)).toContain('src/app/api/organizacoes/route.ts');
  });

  it('quem executa como o usuário no servidor não acessa as seis tabelas', () => {
    const acessosComSessao = fontes
      .filter(({ fonte }) => comSessaoDoUsuario(fonte))
      .flatMap(({ caminho, fonte }) => acessos(fonte).map(({ tabela }) => `${caminho} → ${tabela}`));
    expect(acessosComSessao).toEqual([]);
  });

  it('nenhum arquivo do navegador consulta tabela por nome não literal', () => {
    expect(navegador.filter(({ fonte }) => fromNaoLiteral(fonte)).map((a) => a.caminho)).toEqual([]);
  });
});

/**
 * Contraprova permanente: os detectores acusam as formas que o PRE-006A não
 * via. Se um deles voltar a ficar cego, o teste correspondente falha.
 */
describe('os detectores acusam o que devem (contraprova)', () => {
  it('import relativo do cliente do navegador conta como navegador', () => {
    expect(doNavegador("import { supabase } from './supabaseClient';")).toBe(true);
    expect(doNavegador("import { supabase } from '@/lib/supabaseClient';")).toBe(true);
    expect(doNavegador("import { supabaseServer } from '@/lib/supabaseServer';")).toBe(false);
  });

  it('escrita encadeada é capturada com a tabela', () => {
    const fonte = "await supabase.from('movimentacao_estoque').insert({ quantidade: 1 });";
    expect(acessos(fonte)).toEqual([{ tabela: 'movimentacao_estoque', cadeia: ".insert({ quantidade: 1 })" }]);
  });

  it('tabela por variável é acusada; Storage não', () => {
    expect(fromNaoLiteral('await supabase.from(tabela).update({ estoque: 0 });')).toBe(true);
    expect(fromNaoLiteral("await supabase.storage.from(BUCKET).upload(p, f);")).toBe(false);
    expect(fromNaoLiteral("await supabase.from('produtos').select('id');")).toBe(false);
  });

  it('cliente com a sessão do usuário é reconhecido', () => {
    expect(comSessaoDoUsuario('const r = createActorScopedSupabaseClient(token);')).toBe(true);
  });
});
