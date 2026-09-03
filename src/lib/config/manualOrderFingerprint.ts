import type { ManualOrderRequest } from './manualOrderContract';

/**
 * Impressão digital da INTENÇÃO COMERCIAL de uma venda manual (ticket 30,
 * fatia 3 — 5ª rodada de revisão).
 *
 * ## Por que existe
 *
 * `referenciaLocal` sozinha responde "já vi este UUID antes?". Não responde
 * "isto é a MESMA operação que eu já vi?" — e é essa a pergunta que uma chave
 * de idempotência precisa responder para ser segura. Sem o fingerprint, esta
 * sequência silenciosamente registra a venda errada:
 *
 * 1. tentativa A: cliente X, produto Y, quantidade 1 → resultado indeterminado;
 * 2. a referência fica pendente no `localStorage`;
 * 3. o usuário recarrega a página e MUDA quantidade/produto/cliente;
 * 4. envia de novo, com a MESMA referência.
 *
 * O servidor devolveria o desfecho da tentativa A — "sua venda já foi
 * registrada" — para uma venda que ninguém registrou. Ou, no estado
 * `'falhou'`, reabriria a referência e criaria no Bling uma venda diferente
 * da que a chave identifica.
 *
 * A regra que este módulo torna verificável:
 *
 * - mesma referência + **mesmo** fingerprint → retentativa da MESMA operação;
 * - mesma referência + **outro** fingerprint → conflito. Nunca executa, nunca
 *   devolve o resultado anterior em silêncio.
 *
 * ## O que entra, e por quê
 *
 * Só o que define a intenção comercial — e a política é **incluir na dúvida**,
 * porque os dois erros não são simétricos: um campo a mais no fingerprint faz
 * uma retentativa legítima virar conflito (incômodo, visível, recuperável); um
 * campo a menos faz uma venda DIFERENTE ser tratada como a mesma (silencioso,
 * e o dano é uma venda errada registrada ou duplicada no ERP).
 *
 * | Campo | Entra? | Por quê |
 * |---|---|---|
 * | `clienteId` | sim | quem compra |
 * | `itens` (produto + quantidade) | sim | o que é vendido |
 * | `desconto`, `frete` | sim | mudam o total, o título financeiro e o pedido no Bling |
 * | `formaPagamentoId`, `formaPagamentoRotulo` | sim | mudam a parcela criada no Bling e o registro local |
 * | `observacoes` | sim | viaja no corpo do pedido enviado ao Bling |
 * | `syncBling` | sim | decide se existe ou não uma escrita externa |
 * | `referenciaLocal` | **não** | é a CHAVE, não o conteúdo que ela identifica |
 *
 * Preço unitário e total **não** entram porque não vêm do cliente: são
 * derivados no servidor a partir do cadastro (ver `manualOrderContract.ts`).
 * Duas submissões com os mesmos itens só divergem em preço se o cadastro
 * mudou entre elas, e nesse caso a intenção comercial ("vender estes itens a
 * este cliente") continua a mesma.
 *
 * ## Quem calcula
 *
 * O **servidor**, sempre, a partir do corpo já validado pelo schema — nunca a
 * partir de um fingerprint enviado pelo cliente, que seria só a afirmação do
 * cliente sobre si mesmo. O cliente calcula a sua própria cópia apenas para
 * saber, localmente, se a submissão atual ainda é a mesma operação da
 * referência que ele guardou; essa cópia nunca é enviada nem confiada.
 */

/**
 * Serialização canônica: determinística para o MESMO conteúdo, e diferente
 * para conteúdo diferente.
 *
 * - itens ordenados por `produtoId` (a ordem na tela não é intenção comercial);
 * - números por `String(n)`, que é totalmente especificado pelo ECMA-262
 *   (`Number::toString`) — mesma saída em qualquer engine, sem arredondar:
 *   arredondar colapsaria valores distintos em um só fingerprint, que é
 *   exatamente a direção insegura;
 * - ausente (`undefined`) distinto de vazio, pelo marcador `-`;
 * - prefixo de versão para que uma mudança futura na composição não colida
 *   com fingerprints já gravados.
 */
export function serializacaoCanonicaDaVendaManual(body: ManualOrderRequest): string {
  const itens = [...body.itens]
    .sort((a, b) => (a.produtoId < b.produtoId ? -1 : a.produtoId > b.produtoId ? 1 : 0))
    .map((item) => `${item.produtoId}x${String(item.quantidade)}`)
    .join(',');

  return [
    'v1',
    `cliente:${body.clienteId}`,
    `sync:${body.syncBling ? '1' : '0'}`,
    `desconto:${String(body.desconto)}`,
    `frete:${String(body.frete)}`,
    `formaId:${body.formaPagamentoId === undefined ? '-' : String(body.formaPagamentoId)}`,
    `formaRotulo:${body.formaPagamentoRotulo ?? '-'}`,
    `obs:${body.observacoes ?? '-'}`,
    `itens:${itens}`,
  ].join('|');
}

/**
 * SHA-256 hexadecimal da serialização canônica.
 *
 * `crypto.subtle` é o único digest disponível **dos dois lados** sem
 * dependência nova (navegador e Node 18+), e por isso a função é assíncrona —
 * o custo é irrelevante nos dois chamadores, que já estão em contexto async.
 *
 * Guardar o hash, e não a serialização inteira, mantém a coluna do ledger com
 * tamanho fixo e evita repetir em outra tabela o conteúdo comercial da venda.
 */
export async function fingerprintDaVendaManual(body: ManualOrderRequest): Promise<string> {
  const canonica = serializacaoCanonicaDaVendaManual(body);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonica));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
