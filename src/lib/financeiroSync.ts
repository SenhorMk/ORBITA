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
  readonly success?: unknown;
  readonly error?: unknown;
}

const FALHA_SEM_MENSAGEM = 'Não foi possível concluir a sincronização.';

/** Objeto simples — nem array, nem `null`, nem primitivo. */
function envelopeDeObjeto(corpo: unknown): corpo is RespostaSync {
  return typeof corpo === 'object' && corpo !== null && !Array.isArray(corpo);
}

/**
 * Mensagem do servidor, só quando ela é texto de verdade.
 *
 * O `error` vem de fora do componente e vai direto para a tela; exibi-lo sem
 * conferir o tipo colocaria `[object Object]` na cara do lojista — a mesma
 * família de defeito que o ticket 03 perseguiu.
 */
function mensagemDoServidor(corpo: RespostaSync): string {
  return typeof corpo.error === 'string' && corpo.error.trim().length > 0
    ? corpo.error
    : FALHA_SEM_MENSAGEM;
}

/**
 * Dispara a sincronização e devolve o aviso a mostrar, ou string vazia quando
 * tudo correu bem.
 *
 * **Sucesso é afirmado, nunca presumido.** Antes bastava não existir
 * `success: false` para a tela ficar calada: um HTTP 200 com `{}`, `null`, uma
 * lista ou uma página de HTML de proxy passava por conclusão. Agora só cala
 * quando o corpo é um envelope reconhecível e diz `success: true`.
 *
 * A mensagem exibida é a que o servidor montou: ela já é genérica por
 * construção (CWE-209), sem diagnóstico de banco nem de provedor.
 */
export async function executarSyncFinanceiro(
  fetchWithAuth: (url: string, options?: RequestInit) => Promise<Response>,
): Promise<string> {
  const resposta = await fetchWithAuth('/api/financeiro/sync', { method: 'POST' });
  const corpo: unknown = await resposta.json().catch(() => null);

  if (!envelopeDeObjeto(corpo)) return FALHA_SEM_MENSAGEM;
  if (resposta.ok && corpo.success === true) return '';

  return mensagemDoServidor(corpo);
}
