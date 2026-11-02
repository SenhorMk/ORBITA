import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Detectores comuns aos inventários de escrita direta (PRE-006A comercial,
 * PRE-007A financeiro). Cada teste escolhe as próprias tabelas; as regras de
 * quem é navegador, de quem executa com a sessão do usuário e do que conta
 * como acesso a uma tabela são as mesmas.
 */

const RAIZ = path.resolve(__dirname, '..', '..', '..');

function arquivos(dir: string): string[] {
  return readdirSync(dir).flatMap((nome) => {
    const caminho = path.join(dir, nome);
    if (statSync(caminho).isDirectory()) return nome === 'e2e' ? [] : arquivos(caminho);
    return /\.(ts|tsx)$/.test(nome) && !/\.test\.tsx?$/.test(nome) ? [caminho] : [];
  });
}

/** Os fontes de `src/` que não são teste, com o caminho relativo à raiz. */
export function fontesDoProduto(): Array<{ caminho: string; fonte: string }> {
  return arquivos(path.join(RAIZ, 'src'))
    .map((caminho) => ({ caminho: path.relative(RAIZ, caminho).split(path.sep).join('/'), fonte: readFileSync(caminho, 'utf8') }));
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

/** Cada `.from('<tabela>')` das tabelas pedidas, com a cadeia até o próximo `;`. */
export function acessos(fonte: string, tabelas: readonly string[]): Array<{ tabela: string; cadeia: string }> {
  const encontrados: Array<{ tabela: string; cadeia: string }> = [];
  for (const m of fonte.matchAll(/\.from\(\s*['"]([a-z_]+)['"]\s*\)/g)) {
    const tabela = m[1]!;
    if (!tabelas.includes(tabela)) continue;
    const resto = fonte.slice((m.index ?? 0) + m[0].length);
    const fim = resto.indexOf(';');
    encontrados.push({ tabela, cadeia: fim >= 0 ? resto.slice(0, fim) : resto });
  }
  return encontrados;
}

/** A cadeia grava? */
export function escreve(cadeia: string): boolean {
  return /\.(insert|update|upsert|delete)\(/.test(cadeia);
}
