/**
 * Prazo para as requisições do painel de Integrações.
 *
 * `fetchWithAuth` não tem timeout, e `fetch` também não tem por padrão: uma
 * requisição que trava fica pendurada até o navegador desistir — o que pode
 * não acontecer nunca. No painel isso aparece como "Salvando…" ou
 * "Conectando…" para sempre, que é a versão silenciosa do mesmo defeito que
 * este ticket veio fechar: a tela afirmando um estado que não corresponde a
 * nada.
 *
 * O prazo é aplicado **aqui**, e não dentro de `fetchWithAuth`. Aquele seam é
 * usado por toda a aplicação, incluindo sincronizações longas com o Bling que
 * legitimamente demoram minutos; impor um prazo global as quebraria. As
 * operações desta tela são todas curtas — gravar credenciais, pedir uma URL de
 * autorização, ler o estado —, e para elas trinta segundos já é folgado.
 *
 * `fetchWithAuth` repassa `options` inteiro para `fetch`, então o `signal`
 * chega ao lugar certo sem que nada precise mudar lá.
 */
export const PRAZO_DA_INTEGRACAO_MS = 30_000;

/** Mensagem única do estouro de prazo, para as duas pontas dizerem o mesmo. */
export const MENSAGEM_DE_PRAZO_ESGOTADO =
  'O servidor não respondeu a tempo. Nada foi confirmado — verifique o estado antes de tentar de novo.';

/** Busca autenticada, na forma que o painel recebe. */
type Busca = (url: string, options?: RequestInit) => Promise<Response>;

/**
 * A mesma busca, com prazo.
 *
 * Um estouro de prazo chega ao chamador como um `Error` comum, com a mensagem
 * acima — e não como o `AbortError` cru, que diria "The operation was aborted"
 * a quem só quer saber se as credenciais foram salvas.
 *
 * O aviso importa: a requisição pode ter chegado ao servidor e sido executada.
 * O prazo diz que **não houve confirmação**, não que nada aconteceu, e o texto
 * é honesto sobre essa diferença.
 */
export async function comPrazo(
  buscar: Busca,
  url: string,
  options: RequestInit = {},
  prazoMs: number = PRAZO_DA_INTEGRACAO_MS,
): Promise<Response> {
  const controlador = new AbortController();
  const disparo = setTimeout(() => controlador.abort(), prazoMs);
  try {
    return await buscar(url, { ...options, signal: controlador.signal });
  } catch (causa) {
    if (controlador.signal.aborted) throw new Error(MENSAGEM_DE_PRAZO_ESGOTADO);
    throw causa;
  } finally {
    clearTimeout(disparo);
  }
}
