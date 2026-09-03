import type { BlingProviderFailure } from '@/lib/integrations/bling/pedidoVendaContract';

/**
 * A falha de `POST /pedidos/vendas` prova que o pedido NÃO foi criado, ou
 * deixa isso em aberto? (ticket 30, fatia 3 — 5ª rodada de revisão.)
 *
 * ## O defeito que isto fecha
 *
 * Até a 4ª rodada, TODA falha da sincronização com o Bling — inclusive a
 * criação do pedido — gravava a tentativa como `'falhou'`, que é um estado
 * REABRÍVEL: a próxima submissão com a mesma referência pode chamar
 * `createPedidoVenda` de novo. Isso é correto para uma recusa, e é o raciocínio
 * errado para um timeout:
 *
 *     "não recebi resposta" → "não criou"
 *
 * O pedido pode ter sido criado e a resposta ter se perdido no caminho. Nesse
 * caso o ORBITA nem sabe o `bling_id` — não há o que cancelar nem o que
 * gravar — e uma retentativa criaria um SEGUNDO pedido real na conta do
 * lojista. É a mesma classe de erro que a fatia 3 já fechou para a
 * persistência local (`classificacaoDeFalha.ts`), um passo antes no fluxo.
 *
 * ## A política, por reconhecimento positivo
 *
 * Só é `Definitiva` uma falha que prova que o servidor **recebeu, processou e
 * recusou** a requisição. Tudo o mais é `Ambigua`, e uma tentativa ambígua
 * fica `indeterminada` (bloqueada) em vez de `falhou` (reabrível).
 *
 * - **`Definitiva`:** resposta HTTP `4xx`. Uma resposta assim só existe porque
 *   o Bling avaliou a requisição e a recusou — inclusive a recusa por venda
 *   duplicada (`duplicateSale`), que é o caso comum e legítimo de retentativa.
 *   `429` entra aqui: limitação de taxa é recusa ANTES do processamento.
 * - **`Ambigua`:** `408` (o servidor diz que não terminou de receber),
 *   qualquer `5xx` (pode ter falhado depois de criar), `status` fora da faixa
 *   HTTP conhecida, e o tipo sintético `INVALID_RESPONSE` — este último é o
 *   mais perigoso de todos, porque significa que o Bling respondeu **sucesso**
 *   e o ORBITA não conseguiu ler o id: o pedido existe e nós não sabemos qual é.
 *
 * Uma exceção LANÇADA pela chamada (timeout de rede, conexão perdida, abort)
 * nem chega aqui — não há `BlingProviderFailure` nenhuma para classificar — e
 * é tratada como ambígua na origem, em `handler.ts`.
 *
 * ## A rede de segurança
 *
 * Classificar errado para o lado `Definitiva` reabriria a chave. Por isso
 * existe a reconciliação por `numeroLoja` (`POST /api/pedidos/manual/reconciliar`):
 * mesmo sem `bling_id`, dá para perguntar ao Bling se o pedido com aquela
 * referência existe. Ver `reconciliacao.ts`.
 */
export type ClassificacaoDeFalhaBling = 'Definitiva' | 'Ambigua';

/** Único `status` 4xx que NÃO prova recusa: o servidor declara que não terminou de receber. */
const STATUS_4XX_QUE_NAO_PROVA_RECUSA = 408;

/**
 * Tipo sintético que o próprio ORBITA monta quando o Bling responde 2xx sem um
 * id legível. O pedido foi criado; o que falta é o id. Jamais `Definitiva`,
 * qualquer que seja o `status` que venha junto.
 */
const TIPO_RESPOSTA_ILEGIVEL = 'INVALID_RESPONSE';

/**
 * @param failure - Falha tipada devolvida por `createPedidoVenda`.
 * @returns `'Definitiva'` só quando o Bling comprovadamente recusou;
 *          `'Ambigua'` em qualquer outro caso, inclusive os não previstos.
 */
export function classificarFalhaDeCriacaoNoBling(failure: BlingProviderFailure): ClassificacaoDeFalhaBling {
  if (failure.type === TIPO_RESPOSTA_ILEGIVEL) return 'Ambigua';
  if (failure.status === STATUS_4XX_QUE_NAO_PROVA_RECUSA) return 'Ambigua';
  if (failure.status >= 400 && failure.status <= 499) return 'Definitiva';
  return 'Ambigua';
}
