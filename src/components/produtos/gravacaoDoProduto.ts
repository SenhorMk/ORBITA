import { fetchWithAuth } from '@/lib/fetchWithAuth';
import {
  produtoUpdateResponseSchema,
  type MotivoDaReconciliacao,
  type ProdutoRequest,
} from '@/lib/config/produtoContract';

/**
 * O resultado de `POST /api/produtos/update` como a tela precisa decidir.
 *
 * - `Salvo`: concluído; a tela pode fechar.
 * - `SalvoComAvisos`: salvo, mas algo ficou pela metade (o saldo não foi
 *   confirmado, por exemplo). A tela mostra e **não** fecha sozinha.
 * - `Recusado`: nada foi aplicado; corrigir e reenviar é seguro.
 * - `Indeterminado`: o Bling pode ter aplicado, ou aplicou e o ORBITA não
 *   espelhou. Reenviar pode duplicar o produto; a recuperação é sincronizar o
 *   catálogo. A tela bloqueia a nova tentativa.
 */
export type ResultadoDaGravacao =
  | { readonly _tag: 'Salvo' }
  | { readonly _tag: 'SalvoComAvisos'; readonly avisos: readonly string[] }
  | { readonly _tag: 'Recusado'; readonly mensagem: string; readonly logs: readonly string[] }
  | {
      readonly _tag: 'Indeterminado';
      readonly motivo: MotivoDaReconciliacao | 'resposta_perdida';
      readonly mensagem: string;
      readonly logs: readonly string[];
    };

const MENSAGEM_RESPOSTA_PERDIDA =
  'A resposta do servidor não chegou, e o produto pode ter sido gravado no Bling. Não salve de novo: sincronize o catálogo e confira antes.';

function registro(texto: string): string {
  return `[${new Date().toISOString()}] ${texto}`;
}

/**
 * Envia o produto e classifica a resposta pelo contrato compartilhado
 * (`produtoUpdateResponseSchema`), nunca pelo texto do erro.
 *
 * Uma rejeição de `fetch` (`TypeError`, ou `AbortError`) e uma resposta que
 * não é o JSON do contrato (um `504` do gateway, por exemplo) não provam que
 * nada aconteceu: a requisição pode ter chegado ao servidor. São
 * `Indeterminado`. Já a sessão ausente faz `fetchWithAuth` lançar um `Error`
 * comum **antes** de qualquer requisição — isso é `Recusado`.
 *
 * @param payload - O corpo já validado por `buildProdutoRequest`.
 * @param enviar - O transporte; `fetchWithAuth` em produção.
 */
export async function gravarProduto(
  payload: ProdutoRequest,
  enviar: typeof fetchWithAuth = fetchWithAuth,
): Promise<ResultadoDaGravacao> {
  let resposta: Response;
  try {
    resposta = await enviar('/api/produtos/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (erro: unknown) {
    const naRede = erro instanceof TypeError || (erro instanceof Error && erro.name === 'AbortError');
    const texto = erro instanceof Error ? erro.message : 'Falha ao enviar o produto.';
    return naRede
      ? { _tag: 'Indeterminado', motivo: 'resposta_perdida', mensagem: MENSAGEM_RESPOSTA_PERDIDA, logs: [registro(`Sem resposta: ${texto}`)] }
      : { _tag: 'Recusado', mensagem: texto, logs: [registro(`Não enviado: ${texto}`)] };
  }

  let corpo: unknown;
  try {
    corpo = await resposta.json();
  } catch {
    corpo = undefined;
  }
  const lido = produtoUpdateResponseSchema.safeParse(corpo);
  const status = registro(`HTTP ${resposta.status}`);

  if (!lido.success) {
    return { _tag: 'Indeterminado', motivo: 'resposta_perdida', mensagem: MENSAGEM_RESPOSTA_PERDIDA, logs: [status] };
  }
  const { success, avisos = [], error, reconciliacao } = lido.data;

  if (reconciliacao) {
    return {
      _tag: 'Indeterminado',
      motivo: reconciliacao.motivo,
      mensagem: error ?? MENSAGEM_RESPOSTA_PERDIDA,
      logs: [status, registro(`Reconciliação necessária: ${reconciliacao.motivo}${reconciliacao.blingId ? ` (id Bling ${reconciliacao.blingId})` : ''}`)],
    };
  }
  if (resposta.ok && success) {
    return avisos.length > 0 ? { _tag: 'SalvoComAvisos', avisos } : { _tag: 'Salvo' };
  }
  if (resposta.status >= 500) {
    // Um 5xx sem o estado estruturado é falha não classificada pelo servidor:
    // não há prova de que nada foi aplicado.
    return { _tag: 'Indeterminado', motivo: 'resposta_perdida', mensagem: error ?? MENSAGEM_RESPOSTA_PERDIDA, logs: [status] };
  }
  return { _tag: 'Recusado', mensagem: error ?? 'O produto não foi salvo.', logs: [status] };
}
