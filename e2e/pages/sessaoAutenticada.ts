import type { Page } from '@playwright/test';

/**
 * Token da sessão logada, lido de onde o `supabase-js` o guarda no navegador.
 *
 * Os helpers de API foram escritos assumindo que `page.request` levaria a
 * sessão junto, porque compartilha os cookies da página. A suposição está
 * errada: `readBearerToken` lê o token **exclusivamente** do header
 * `Authorization` e não olha cookie nenhum. Toda chamada de API das specs
 * recebia 401 — e ninguém soube, porque a suíte nunca chegou a rodar.
 *
 * É a mesma falsa premissa que matou nove chamadas da interface (ticket 12),
 * repetida na camada de teste.
 */
export async function tokenDaSessao(page: Page): Promise<string> {
  const token = await page.evaluate(() => {
    const chave = Object.keys(window.localStorage).find(
      (k) => k.startsWith('sb-') && k.endsWith('-auth-token'),
    );
    if (!chave) return null;
    try {
      const bruto = window.localStorage.getItem(chave);
      return bruto ? (JSON.parse(bruto) as { access_token?: string }).access_token ?? null : null;
    } catch {
      return null;
    }
  });

  if (!token) {
    throw new Error(
      'Nenhuma sessão do Supabase no navegador. O login precisa ter concluído antes de chamar a API — '
        + 'sem token, toda rota autenticada responde 401 e o teste falha por um motivo que não é o que ele mede.',
    );
  }

  return token;
}

/** Cabeçalhos de uma requisição autenticada, prontos para `page.request`. */
export async function cabecalhosAutenticados(page: Page): Promise<Record<string, string>> {
  return { Authorization: `Bearer ${await tokenDaSessao(page)}` };
}
