import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guarda contra **chamada de API sem credencial**.
 *
 * O servidor lê o token exclusivamente do header `Authorization`
 * (`readBearerToken`), sem olhar cookie nenhum. Um `fetch('/api/...')` cru de
 * dentro de um componente recebe 401 — sempre, sem exceção.
 *
 * Nove chamadas em oito componentes faziam exatamente isso, porque o
 * `fetchWithAuth` existia como função local dentro de `page.tsx` e ninguém
 * mais alcançava. Cancelar pedido, editar cliente, editar produto, abrir o
 * detalhe de um pedido e sincronizar categorias estavam todos mortos pela
 * mesma causa, e o sintoma na tela era `(intermediate value).find is not a
 * function` — porque o corpo do 401 é `{ error }` e o código o tratava como
 * lista.
 *
 * Confirmado contra a aplicação publicada em 2026-08-31: `/api/bling/situacoes`,
 * `/api/pedidos/status`, `/api/clientes/update`, `/api/produtos/update`,
 * `/api/categorias/sync` e `/api/pedidos/manual` responderam 401 sem o header.
 */

const RAIZ = path.resolve(__dirname, '..', '..');

/**
 * Rotas que dispensam sessão, e por quê. Qualquer outra precisa de token.
 */
const ROTAS_PUBLICAS = new Set([
  '/api/auth/register', // criar conta é o que produz a sessão; exigir uma seria circular
]);

function arquivosDeInterface(dir: string): string[] {
  const encontrados: string[] = [];
  for (const entrada of readdirSync(dir)) {
    const completo = path.join(dir, entrada);
    if (statSync(completo).isDirectory()) {
      // `src/app/api` é servidor: quem mora lá não faz fetch para si mesmo.
      if (completo.replace(/\\/gu, '/').endsWith('src/app/api')) continue;
      encontrados.push(...arquivosDeInterface(completo));
    } else if (/\.tsx$/u.test(entrada) && !/\.test\.tsx$/u.test(entrada)) {
      encontrados.push(completo);
    }
  }
  return encontrados;
}

/** Chamadas `fetch(...)` para `/api/...` escritas na interface. */
export function chamadasCruas(): Array<{ arquivo: string; rota: string }> {
  const cruas: Array<{ arquivo: string; rota: string }> = [];
  // `fetch(` não precedido de `WithAuth`, apontando para /api/...
  const PADRAO = /(?<!WithAuth)\bfetch\(\s*[`'"](\/api\/[^`'"$]*)/gu;

  for (const arquivo of arquivosDeInterface(path.join(RAIZ, 'src'))) {
    const fonte = readFileSync(arquivo, 'utf8');
    const relativo = path.relative(RAIZ, arquivo).replace(/\\/gu, '/');
    for (const m of fonte.matchAll(PADRAO)) {
      cruas.push({ arquivo: relativo, rota: m[1]!.replace(/\/$/u, '') });
    }
  }
  return cruas;
}

describe('a interface não chama a API sem credencial', () => {
  const cruas = chamadasCruas();

  it('o teste enxerga o código da interface', () => {
    const total = readFileSync(path.join(RAIZ, 'src/components/TransactionList.tsx'), 'utf8');
    expect(total).toContain('fetchWithAuth');
  });

  it('nenhuma chamada crua para rota que exige sessão', () => {
    const proibidas = cruas.filter((c) => !ROTAS_PUBLICAS.has(c.rota));

    expect(
      proibidas.map((c) => `${c.arquivo} → ${c.rota}`),
      'O servidor lê o token só do header Authorization. `fetch` cru recebe 401, '
        + 'e o corpo do 401 é um objeto — foi assim que um 401 virou '
        + '"(intermediate value).find is not a function" na tela. Use `fetchWithAuth`.',
    ).toEqual([]);
  });

  it('o helper compartilhado existe e manda o header', () => {
    const helper = readFileSync(path.join(RAIZ, 'src/lib/fetchWithAuth.ts'), 'utf8');
    expect(helper).toContain('Authorization');
    expect(helper).toContain('Bearer');
  });

  it('sem sessão o helper falha com mensagem legível, e não com 401 mudo', () => {
    const helper = readFileSync(path.join(RAIZ, 'src/lib/fetchWithAuth.ts'), 'utf8');
    // Mandar a requisição sem token empurra o erro para longe da causa.
    expect(helper).toMatch(/if\s*\(!token\)[\s\S]{0,120}throw/u);
  });
});
