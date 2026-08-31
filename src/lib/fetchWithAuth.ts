import { supabase } from './supabaseClient';

/**
 * `fetch` que envia o token da sessão no header `Authorization`.
 *
 * O servidor lê o token **exclusivamente** do header — `readBearerToken` não
 * olha cookie nenhum. Então qualquer `fetch('/api/...')` cru de dentro de um
 * componente recebe 401, sempre.
 *
 * Isso não era teórico: nove chamadas em oito componentes usavam `fetch` cru,
 * e o `fetchWithAuth` existia apenas como função local dentro de `page.tsx`,
 * fora do alcance de todo mundo. Cancelar pedido, editar cliente, editar
 * produto, abrir o detalhe de um pedido e sincronizar categorias estavam todos
 * mortos pela mesma causa.
 *
 * O sintoma que apareceu na tela foi `(intermediate value).find is not a
 * function`: a rota devolve `{ error: 'Não autorizado' }` no 401, e o cliente
 * chamava `.find` em cima disso achando que era lista.
 *
 * Sem sessão, esta função **lança** com mensagem legível em vez de mandar a
 * requisição sem credencial e deixar o 401 virar um erro de tipo lá na frente.
 *
 * Guarda: `src/lib/fetch-autenticado.test.ts`.
 */
export async function fetchWithAuth(url: string, options: RequestInit = {}): Promise<Response> {
  const { data, error } = await supabase.auth.getSession();

  if (error) {
    throw new Error(`Não foi possível ler sua sessão: ${error.message}`);
  }

  const token = data.session?.access_token;
  if (!token) {
    throw new Error('Sua sessão expirou. Entre novamente para continuar.');
  }

  return fetch(url, {
    ...options,
    headers: {
      ...(options.headers as Record<string, string> | undefined),
      Authorization: `Bearer ${token}`,
    },
  });
}
