/**
 * Ponte entre a rota de sincronização financeira e a tela.
 *
 * Mora fora do componente para poder ser exercitada contra a **resposta real**
 * que o handler produz, e não contra uma forma remontada no teste. A ligação
 * entre as duas pontas é exatamente o que faltava: a rota passou a reportar
 * falha e parcialidade no ticket 05, e a tela continuou tratando tudo como
 * sucesso — porque `fetchWithAuth` devolve a `Response` sem lançar em não-2xx.
 */

/** Corpo que a rota devolve; só o que a tela precisa olhar. */
interface RespostaSync {
  readonly success?: boolean;
  readonly error?: string;
}

const FALHA_SEM_MENSAGEM = 'Não foi possível concluir a sincronização.';

/**
 * Dispara a sincronização e devolve o aviso a mostrar, ou string vazia quando
 * tudo correu bem.
 *
 * A mensagem exibida é a que o servidor montou: ela já é genérica por
 * construção (CWE-209), sem diagnóstico de banco nem de provedor.
 */
export async function executarSyncFinanceiro(
  fetchWithAuth: (url: string, options?: RequestInit) => Promise<Response>,
): Promise<string> {
  const resposta = await fetchWithAuth('/api/financeiro/sync', { method: 'POST' });
  const corpo = await resposta.json().catch(() => null) as RespostaSync | null;

  return !resposta.ok || corpo?.success === false
    ? corpo?.error || FALHA_SEM_MENSAGEM
    : '';
}
