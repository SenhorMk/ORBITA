import type { ManualOrderRequest } from './manualOrderContract';

/**
 * Fingerprint da venda manual: um resumo (hash SHA-256) do que a venda É.
 *
 * ## Por que existe
 *
 * Idempotência é poder repetir a mesma tentativa sem repetir o efeito externo.
 * Para isso não basta a referência (`referenciaLocal`): ela responde "já vi
 * este UUID antes?", mas não "isto é a MESMA venda que eu já vi?". Sem o
 * fingerprint, esta sequência registraria a venda errada em silêncio
 * (por exemplo, com um cliente desatualizado ou uma chamada direta à API):
 *
 * 1. tentativa A: cliente X, produto Y, quantidade 1 → resultado indeterminado;
 * 2. a mesma referência é reenviada;
 * 3. mas agora com outra quantidade, outro produto ou outro cliente.
 *
 * O servidor devolveria o desfecho da tentativa A — "sua venda já foi
 * registrada" — para uma venda que ninguém registrou. Ou, no estado
 * `'falhou'`, reabriria a referência e criaria no Bling uma venda diferente
 * da que a chave identifica.
 *
 * A regra que este módulo torna verificável:
 *
 * - mesma referência + **mesmo** fingerprint → retentativa da MESMA operação;
 * - mesma referência + **outro** fingerprint → conflito. A RPC recusa antes de
 *   executar qualquer coisa e não devolve o resultado anterior.
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
 * este cliente") continua a mesma. A mudança de valor é tratada à parte, por
 * `fingerprintDosValoresResolvidos`.
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
 * Transforma a venda num texto único, antes do hash.
 *
 * A serialização precisa ser sem ambiguidade: duas vendas diferentes não podem
 * gerar o mesmo texto antes do hash. Em termos matemáticos, essa propriedade é
 * chamada de injetividade.
 *
 * ## Por que não concatenar com separadores
 *
 * Num formato como `cliente:<uuid>|obs:<texto>|itens:<id>x<qtd>`, duas vendas
 * diferentes poderiam virar a mesma string: `observacoes` e
 * `formaPagamentoRotulo` são texto livre, e se a pessoa escrever `|`, `:`, `,`
 * ou `x` nesses campos, o texto de uma venda pode ficar idêntico ao de outra.
 * O SHA-256 não resolve isso: se as duas strings já são iguais, o hash também
 * será.
 *
 * ## O formato `v2`
 *
 * `JSON.stringify` sobre um array de posições fixas. A falta de ambiguidade vem
 * da própria gramática do JSON: toda string é delimitada por aspas e todo `"` ou
 * `\` interno é escapado, então o conteúdo nunca pode ser confundido com a
 * estrutura que o cerca. Dois valores diferentes em qualquer posição produzem
 * documentos JSON diferentes, quaisquer que sejam os caracteres dentro deles.
 *
 * A ordem das posições é fixa no código (não depende de ordem de chaves de
 * objeto), e `JSON.stringify` de números segue `Number::toString` do ECMA-262 —
 * totalmente especificado, mesma saída em qualquer engine.
 *
 * Ausente é `null`, distinto de `''`. Itens são ordenados por `produtoId`,
 * porque a ordem na tela não é intenção comercial. O primeiro elemento (`'v2'`)
 * versiona o formato: mudar a serialização exige mudar esse marcador.
 */
export function serializacaoCanonicaDaVendaManual(body: ManualOrderRequest): string {
  const itens = [...body.itens]
    .sort((a, b) => (a.produtoId < b.produtoId ? -1 : a.produtoId > b.produtoId ? 1 : 0))
    .map((item) => [item.produtoId, item.quantidade] as const);

  return JSON.stringify([
    'v2',
    body.clienteId,
    body.syncBling,
    body.desconto,
    body.frete,
    body.formaPagamentoId ?? null,
    body.formaPagamentoRotulo ?? null,
    body.observacoes ?? null,
    itens,
  ]);
}

/**
 * SHA-256 hexadecimal da serialização canônica.
 *
 * `crypto.subtle` está disponível **dos dois lados** sem dependência nova
 * (navegador e Node 18+), e por isso a função é assíncrona —
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

/**
 * Item já resolvido contra o cadastro, com o preço em que o servidor confia.
 * Espelha `ResolvedManualOrderItem` sem importar a camada de rota (o
 * verificador de limites do monólito proíbe essa direção).
 */
export interface ValorResolvidoDeItem {
  readonly produtoId: string;
  readonly precoUnitario: number;
}

/**
 * Impressão digital dos **valores efetivos** da venda — preços unitários
 * resolvidos no servidor e total derivado.
 *
 * ## A decisão de domínio que isto implementa
 *
 * O fingerprint do pedido (acima) cobre o que o cliente PEDIU. Ele não cobre o
 * que a venda VALE, porque preço e total não vêm do cliente: são derivados do
 * cadastro no servidor. O caso que ele sozinho deixaria aberto:
 *
 * 1. tentativa com referência R e produto P;
 * 2. a tentativa falha definitivamente e fica reabrível;
 * 3. **o preço de P muda no cadastro**;
 * 4. retentativa com a mesma referência e o mesmo corpo;
 * 5. o fingerprint do pedido continua idêntico — e a venda passaria a valer
 *    outro valor.
 *
 * **A regra adotada: uma retentativa reexecuta a MESMA venda autorizada.** O
 * usuário confirmou uma venda por um total que viu na tela; reexecutar por
 * outro valor não é retentativa, é uma venda diferente usando a chave da
 * anterior. Por isso os valores resolvidos são congelados na tentativa, e uma
 * divergência **impede a reabertura silenciosa** — a submissão é recusada com
 * uma mensagem que diz que os preços mudaram, e a venda precisa ser
 * reconfirmada.
 *
 * A alternativa — reabrir executando o preço novo — foi descartada: ela muda
 * pedido, total e título financeiro sem que ninguém tenha confirmado o valor
 * novo, e o faz em silêncio.
 *
 * ## Onde a comparação acontece
 *
 * Só na REABERTURA de uma tentativa `falhou`, dentro de
 * `reivindicar_tentativa_venda_manual` (migration 59). Nos outros estados a divergência
 * não muda nada: `concluida` devolve o resultado que já existe (a venda
 * aconteceu pelo valor da época, e é esse que vale), e `em_andamento` /
 * `indeterminada` já bloqueiam por conta própria.
 */
export async function fingerprintDosValoresResolvidos(
  itens: readonly ValorResolvidoDeItem[],
  total: number,
): Promise<string> {
  const ordenados = [...itens]
    .sort((a, b) => (a.produtoId < b.produtoId ? -1 : a.produtoId > b.produtoId ? 1 : 0))
    .map((item) => [item.produtoId, item.precoUnitario] as const);

  const canonica = JSON.stringify(['valores-v1', total, ordenados]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonica));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
