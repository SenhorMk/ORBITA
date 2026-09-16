import type { BlingProviderFailure } from '@/lib/integrations/bling/pedidoVendaContract';

/**
 * A falha de `POST /pedidos/vendas` (ou do `PATCH` de cancelamento) **prova**
 * que o efeito não aconteceu, ou deixa isso em aberto?
 *
 * ## Por que a pergunta importa
 *
 * Uma tentativa `'falhou'` é REABRÍVEL: a próxima submissão com a mesma
 * referência pode chamar `createPedidoVenda` de novo. Isso é correto para uma
 * recusa comprovada, e errado para um timeout:
 *
 *     "não recebi resposta" → "não criou"   (inferência inválida)
 *
 * **Faixa numérica de status HTTP não é prova de ausência de efeito.** Um
 * `429`, por exemplo, plausivelmente acontece antes do processamento, mas o
 * contrato do Bling não afirma isso — e a inferência seria usada para
 * autorizar uma nova criação externa.
 *
 * A política é **reconhecimento positivo por tipo de erro do contrato**,
 * a mesma forma já usada em `classificacaoDeFalha.ts` para o banco:
 *
 * - `Definitiva` **só** quando o corpo de erro da v3 traz um `error.type` que
 *   descreve uma recusa da REQUISIÇÃO — validação, autenticação, autorização
 *   ou roteamento —, e o status é `4xx`. Os dois juntos, nunca um só.
 * - **Tudo o mais é `Ambigua`**, e uma tentativa ambígua fica `indeterminada`
 *   (bloqueada) em vez de `falhou` (reabrível): `429`, `408`, qualquer `5xx`,
 *   `RESOURCE_NOT_FOUND`, `UNKNOWN_ERROR`, um `4xx` cujo corpo não é o
 *   envelope da v3 (o `type` vira `HTTP_<status>` e não há contrato para
 *   invocar), `INVALID_RESPONSE` (o Bling respondeu **sucesso** e o id não foi
 *   legível: o pedido existe e não sabemos qual é), e qualquer combinação não
 *   prevista.
 *
 * Uma exceção LANÇADA pela chamada (timeout de rede, conexão perdida, abort)
 * nem chega aqui — não há `BlingProviderFailure` para classificar — e é
 * tratada como ambígua na origem, em `handler.ts`.
 *
 * ## O custo de errar para cada lado, que é o que justifica a assimetria
 *
 * Classificar como `Ambigua` algo que de fato não criou nada: a venda fica
 * bloqueada até alguém conferir. Incômodo, visível, e com saída pronta — a
 * reconciliação por `numeroLoja` responde em uma chamada de leitura.
 *
 * Classificar como `Definitiva` algo que criou: a chave reabre, a retentativa
 * cria um SEGUNDO pedido real na conta do lojista, e ninguém fica sabendo.
 *
 * ## A saída do estado ambíguo
 *
 * A reconciliação por `numeroLoja` (`POST /api/pedidos/manual/reconciliar`)
 * consulta o Bling e conclui quando a resposta é determinante; quando a
 * consulta não encontra nada, a tentativa continua bloqueada até uma decisão
 * explícita. Ver `reconciliacao.ts`.
 */
export type ClassificacaoDeFalhaBling = 'Definitiva' | 'Ambigua';

/**
 * Os `error.type` da API v3 que descrevem uma recusa **da requisição**, antes
 * de qualquer efeito no domínio: o corpo não passou na validação, a
 * identidade não foi aceita, ou a rota não existe. São os tipos que o
 * contrato descreve como recusa da requisição, e por isso o fluxo os trata
 * como prova de que o pedido não chegou a ser criado.
 *
 * Lidos do enum oficial em `blingErrorTypeSchema`
 * (`src/lib/integrations/bling/pedidoVendaContract.ts`), que por sua vez veio
 * do OpenAPI publicado.
 *
 * **Deliberadamente fora desta lista**, embora estejam no mesmo enum:
 *
 * - `TOO_MANY_REQUESTS` (`429`) — plausivelmente uma recusa anterior ao
 *   processamento, mas o contrato não afirma isso, e a inferência seria usada
 *   para autorizar uma segunda criação externa.
 * - `RESOURCE_NOT_FOUND` — num `POST` de criação, não é inequívoco o que não
 *   foi encontrado nem em que ponto do processamento.
 * - `UNKNOWN_ERROR`, `SERVER_ERROR`, `NOT_IMPLEMENTED` — nada afirmam sobre
 *   efeito.
 */
const TIPOS_QUE_PROVAM_RECUSA_DA_REQUISICAO: ReadonlySet<string> = new Set([
  'BAD_REQUEST',
  'VALIDATION_ERROR',
  'MISSING_REQUIRED_FIELD_ERROR',
  'EMPTY_REQUEST_BODY',
  'INVALID_REQUEST_BODY',
  'INVALID_APIKEY_ERROR',
  'UNAUTHORIZED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'METHOD_NOT_ALLOWED',
]);

function ehStatusDeRecusaDoCliente(status: number): boolean {
  return Number.isInteger(status) && status >= 400 && status <= 499;
}

/**
 * @param failure - Falha tipada devolvida por `createPedidoVenda`.
 * @returns `'Definitiva'` só com reconhecimento positivo — `error.type` de
 *          recusa da requisição **e** status `4xx`. `'Ambigua'` em qualquer
 *          outro caso, inclusive os não previstos.
 */
export function classificarFalhaDeCriacaoNoBling(failure: BlingProviderFailure): ClassificacaoDeFalhaBling {
  if (!TIPOS_QUE_PROVAM_RECUSA_DA_REQUISICAO.has(failure.type)) return 'Ambigua';
  if (!ehStatusDeRecusaDoCliente(failure.status)) return 'Ambigua';
  return 'Definitiva';
}
