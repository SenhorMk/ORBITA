/**
 * Saldo físico por produto a partir da lista crua de `GET /estoques/saldos`.
 *
 * **Só entra saldo comprovado.** O valor tem de vir explícito, como número
 * inteiro finito: `saldoFisicoTotal` quando o campo existe, senão
 * `saldoFisico`. Zero informado pelo Bling é zero. Campo ausente, `null`,
 * texto, fração (o estoque local é inteiro) ou formato desconhecido não entram
 * no mapa — o produto fica pendente de reconciliação, e nenhuma RPC de
 * alinhamento recebe um saldo que ninguém informou. A versão anterior fazia
 * `Number(… ?? 0)`, e a ausência virava uma saída de estoque.
 *
 * O mesmo produto repetido com saldos diferentes também fica de fora: não há
 * como saber qual deles vale.
 *
 * @param itens - O corpo `data` de `getEstoquesSaldos`, sem nenhuma suposição de forma.
 * @returns `bling_id` do produto → saldo comprovado.
 */
export function saldosComprovados(itens: readonly unknown[]): ReadonlyMap<string, number> {
  const saldos = new Map<string, number>();
  const ambiguos = new Set<string>();

  for (const item of itens) {
    if (!item || typeof item !== 'object') continue;
    const registro = item as Record<string, unknown>;
    const produto = registro.produto as Record<string, unknown> | undefined;
    const id = produto && (typeof produto.id === 'number' || typeof produto.id === 'string') ? String(produto.id).trim() : '';
    if (!/^[1-9]\d*$/u.test(id)) continue;

    const bruto = 'saldoFisicoTotal' in registro ? registro.saldoFisicoTotal : registro.saldoFisico;
    if (typeof bruto !== 'number' || !Number.isInteger(bruto)) continue;

    const anterior = saldos.get(id);
    if (anterior !== undefined && anterior !== bruto) ambiguos.add(id);
    saldos.set(id, bruto);
  }

  for (const id of ambiguos) saldos.delete(id);
  return saldos;
}
