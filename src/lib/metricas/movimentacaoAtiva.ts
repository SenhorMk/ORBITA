/**
 * A regra que decide o que é MOVIMENTAÇÃO ATIVA — e, por consequência, o que
 * entra em Total Entradas, Total Saídas e Saldo.
 *
 * ## Por que isto existe
 *
 * Havia duas respostas para a mesma pergunta, e elas discordavam:
 *
 * - `FinanceiroRepository.getResumo`, que alimenta os três cards, filtrava
 *   `situacao = 'pago'`;
 * - `titulosElegiveis`, que alimenta a tabela e os dois gráficos, aceitava
 *   `'pago'` **e** `'aberto'`.
 *
 * O efeito era o defeito reproduzido no staging: lançar uma despesa em aberto
 * mudava o gráfico e a tabela, e os cards acima não se moviam. Quem olha a tela
 * não tem como saber que os números de cima e os de baixo respondem perguntas
 * diferentes — lê como número errado, e num painel de dinheiro número errado é
 * o pior defeito que existe.
 *
 * A correção não é copiar a lista de situações para o repositório: é ter **um**
 * lugar que responde "isto conta como movimentação ativa?", importado pelos
 * dois lados. É o mesmo desenho de `vendasAtivas.ts`, pela mesma razão — e,
 * como lá, o servidor continua sendo a autoridade do resumo: nada passa a ser
 * recalculado no navegador.
 *
 * ## O que um título terminal continua sendo
 *
 * Histórico. `cancelado` e `estornado` permanecem listados, consultáveis e
 * auditáveis nas Últimas Movimentações — saem apenas dos totais. Uma despesa
 * cancelada não deixou de ter existido; ela deixou de ser dinheiro a sair.
 *
 * ## E `aberto` não é "talvez"
 *
 * Um título em aberto é compromisso assumido: a despesa foi lançada, a receita
 * foi combinada. O Financeiro do ORBITA é a visão do que a operação deve e tem
 * a receber, não o extrato do que já passou pelo caixa — é por isso que a
 * tabela e os gráficos sempre o contaram, e é essa noção que os cards passam a
 * compartilhar.
 */

/** As situações que somam nos totais. */
export const SITUACOES_ATIVAS = ['aberto', 'pago'] as const;

/**
 * As situações terminais, que ficam no histórico e fora dos totais.
 *
 * Declaradas explicitamente, e não deduzidas por exclusão: uma situação nova
 * que apareça no provedor não deve entrar em nenhuma das duas listas por
 * acidente — e o `movimentacaoContaComoAtiva` abaixo fecha para quem não é
 * nomeadamente ativa.
 */
export const SITUACOES_TERMINAIS = ['cancelado', 'estornado'] as const;

export type SituacaoAtiva = (typeof SITUACOES_ATIVAS)[number];

/**
 * A situação conta como movimentação ativa?
 *
 * Fecha por omissão: só é ativa a situação nomeada em `SITUACOES_ATIVAS`.
 * Qualquer outra — terminal conhecida, valor nulo, ou uma situação que o
 * provedor venha a inventar — fica fora dos totais até alguém decidir
 * explicitamente o contrário. Num painel de dinheiro, incluir por engano é
 * pior que excluir por engano: o segundo aparece como número faltando, o
 * primeiro como número errado.
 */
export function movimentacaoContaComoAtiva(situacao: string | null | undefined): boolean {
  return typeof situacao === 'string' && (SITUACOES_ATIVAS as readonly string[]).includes(situacao);
}
