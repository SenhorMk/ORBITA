import type { PedidoEnriquecido } from '@/repositories/pedidoRepository';

/**
 * Período, busca e ordenação de Vendas & Pedidos.
 *
 * A semântica é a que a tela já tinha antes da migração visual — os mesmos
 * quatro períodos, os mesmos três critérios de ordenação, os mesmos campos de
 * busca mais o documento do cliente. O que mudou foi a apresentação: o menu com
 * gradiente virou pills, porque gradiente em controle é proibido pelo Design
 * System. Trocar a aparência de um filtro não é motivo para trocar o que ele
 * filtra.
 *
 * **Vendas & Pedidos é histórico operacional.** Nada aqui remove pedido
 * cancelado: ele continua listado, buscável e abrível. `apenasVendasAtivas` só
 * entra onde a pergunta é mesmo "isto é venda?" — nos chips de resumo, e lá
 * dentro da regra de cada um.
 */

export type Periodo = 'all' | '7' | '30' | '90';
export type Ordem = 'recent' | 'old' | 'highest';

export const PERIODOS: ReadonlyArray<{ id: Periodo; rotulo: string }> = [
  { id: 'all', rotulo: 'Todo o período' },
  { id: '7', rotulo: '7 dias' },
  { id: '30', rotulo: '30 dias' },
  { id: '90', rotulo: '90 dias' },
];

export const ORDENS: ReadonlyArray<{ id: Ordem; rotulo: string }> = [
  { id: 'recent', rotulo: 'Mais recentes' },
  { id: 'old', rotulo: 'Mais antigos' },
  { id: 'highest', rotulo: 'Maior valor' },
];

/**
 * O recorte de período — a **base** de tudo o que a tela mostra.
 *
 * @param baseline - O "agora" da tela, fixado uma vez por montagem. Sem isso o
 *   corte se moveria a cada renderização e a mesma lista daria contagens
 *   diferentes em dois desenhos seguidos.
 */
export function recortarPorPeriodo<T extends { data: string }>(
  pedidos: readonly T[],
  periodo: Periodo,
  baseline: number,
): T[] {
  if (periodo === 'all') return [...pedidos];
  const limite = baseline - Number(periodo) * 24 * 60 * 60 * 1000;
  return pedidos.filter((pedido) => new Date(pedido.data).getTime() >= limite);
}

/**
 * A busca textual.
 *
 * Casa número do pedido, nome do cliente, documento do cliente e status. O
 * documento entra porque `PedidoEnriquecido` já traz o cliente embutido com
 * `cpf_cnpj` — nenhuma leitura nova foi criada para isto. SKU **não** entra: a
 * listagem não carrega os itens do pedido, e buscar por um campo que não está
 * na mão exigiria mudar a API.
 */
export function buscar(pedidos: readonly PedidoEnriquecido[], texto: string): PedidoEnriquecido[] {
  const alvo = texto.trim().toLowerCase();
  if (alvo === '') return [...pedidos];
  // O documento é comparado também sem pontuação: quem digita "11644673444"
  // está procurando o mesmo cliente de "116.446.734-44".
  const soDigitos = alvo.replace(/\D/g, '');
  return pedidos.filter((pedido) => {
    const documento = pedido.cliente?.cpf_cnpj ?? '';
    return (
      pedido.numero.toLowerCase().includes(alvo)
      || (pedido.cliente?.nome ?? '').toLowerCase().includes(alvo)
      || (pedido.status ?? '').toLowerCase().includes(alvo)
      || documento.toLowerCase().includes(alvo)
      || (soDigitos !== '' && documento.replace(/\D/g, '').includes(soDigitos))
    );
  });
}

/** A ordenação. Não depende de nada visual e devolve sempre a mesma ordem. */
export function ordenar<T extends { data: string; total: number | string }>(
  pedidos: readonly T[],
  ordem: Ordem,
): T[] {
  const copia = [...pedidos];
  if (ordem === 'recent') copia.sort((a, b) => new Date(b.data).getTime() - new Date(a.data).getTime());
  else if (ordem === 'old') copia.sort((a, b) => new Date(a.data).getTime() - new Date(b.data).getTime());
  else copia.sort((a, b) => Number(b.total) - Number(a.total));
  return copia;
}

/**
 * O rótulo de `pedidos.origem`.
 *
 * `origem` guarda `'Bling'` ou `'Loja Física / Manual'` — de onde o pedido
 * entrou no Orbita. **Não é canal de venda**: não existe Mercado Livre nem
 * Shopee aqui, e a coluna CANAL do mockup ficou de fora justamente por isso.
 * Chamar esta coluna de "canal" seria dar a ela um significado que ela não tem.
 */
export function descreverOrigem(origem: string | null | undefined): string {
  const bruto = (origem ?? '').trim();
  if (bruto === '') return '—';
  if (bruto.toLowerCase() === 'bling') return 'Bling';
  if (bruto.toLowerCase().includes('manual')) return 'Loja física';
  return bruto;
}
