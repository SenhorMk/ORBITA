/**
 * Portas e tipos da sincronização financeira (`POST /api/financeiro/sync`).
 *
 * Mesma costura de portas usada por `pedidos/manual`, `pedidos/status` e
 * `categorias/sync`: o handler depende destas interfaces, e os testes montam
 * dublês completos em vez de mockar módulos.
 */
import type { NextResponse } from 'next/server';

import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import type { TituloFinanceiro } from '@/types';

/** As duas direções sincronizadas, e o nome do checkpoint de cada uma. */
export type EntidadeFinanceira = 'financeiro_contas_pagar' | 'financeiro_contas_receber';

/**
 * Campos que o OpenAPI oficial **declara** para `GET /contas/pagar`
 * (`ContasDadosBaseDTO`) e `GET /contas/receber`
 * (`ContasReceberDadosListDTO`).
 *
 * Conferido campo a campo por `bling-schemas.test.ts`, que falha no commit se
 * divergir.
 */
export interface ContaFinanceiraOficial {
  /** `integer` no spec. O tipo afirma o contrato; as conversões no handler
   * continuam defensivas contra o que o provedor de fato mandar. */
  id?: number;
  situacao?: number;
  valor?: number;
  vencimento?: string;
  /**
   * A origem da conta, declarada em `ContasReceberDadosListDTO`.
   *
   * É o **único** identificador estrutural que o contrato oficial oferece
   * entre uma conta a receber e o pedido que a gerou: `ContasReceberOrigemDTO`
   * documenta `id` como "ID da venda ou nota fiscal que originou a conta", e
   * `tipoOrigem` é quem diz de qual das duas se trata (`venda`, no exemplo do
   * spec). Sem `tipoOrigem === 'venda'` o `id` pode ser de uma nota fiscal, e
   * casar isso com um pedido seria ligar receita a pedido errado.
   *
   * Vem na LISTAGEM que a sincronização já lê — nenhuma leitura nova.
   *
   * Declarado em várias linhas de propósito: é assim que `camposDeclarados`
   * enxerga os campos aninhados, e é isso que faz a guarda do OpenAPI comparar
   * `id` e `tipoOrigem` contra o catálogo congelado em vez de parar em "existe
   * um objeto chamado origem". Os dois sustentam um relacionamento financeiro,
   * e uma troca silenciosa de tipo lá precisa quebrar o teste.
   */
  origem?: {
    id?: number;
    tipoOrigem?: string;
  };
}

/**
 * Campos que o código lê e o OpenAPI oficial **não declara**.
 *
 * Nem `pagamento` nem `historico` existem em qualquer um dos dois DTOs do
 * spec. Se o spec estiver certo, `data_pagamento` chega sempre `undefined` e
 * `descricao` cai sempre no rótulo genérico.
 *
 * **Ficam aqui mesmo assim**, porque o spec do Bling nem sempre descreve tudo
 * o que a API devolve: removê-los apagaria a descrição das contas caso a API
 * de fato os envie. Questão em aberto: só uma resposta real da API confirma
 * se esses campos existem.
 */
export interface ContaFinanceiraNaoDocumentada {
  pagamento?: { data?: string };
  historico?: string;
}

/** Item de conta como o Bling devolve, antes de virar `TituloFinanceiro`. */
export type RawContaFinanceira = ContaFinanceiraOficial & ContaFinanceiraNaoDocumentada;

/**
 * Leitura das contas no Bling.
 *
 * **Lança** quando a leitura falha. Devolver `[]` em 401, 403, 500 ou timeout
 * faria o laço ver lista vazia, parar, avançar o checkpoint e responder
 * sucesso com zero processados.
 */
export interface FinanceiroSyncBlingPort {
  lerPagina(entidade: EntidadeFinanceira, pagina: number, limite: number): Promise<readonly RawContaFinanceira[]>;
}

/** Uma conta a receber que declara ter nascido de uma venda, e qual venda. */
export interface CandidatoDeVinculo {
  readonly contaBlingId: number;
  /** `origem.id` — o id do pedido de venda no Bling, como texto. */
  readonly pedidoBlingId: string;
}

export interface FinanceiroSyncStorePort {
  upsertTitulo(scope: VerifiedOrganizationScope, titulo: TituloFinanceiro): Promise<void>;
  /**
   * Traduz `origem.id` no pedido LOCAL, e só quando o vínculo é seguro.
   *
   * Devolve o mapa `contaBlingId -> pedidos.id` apenas para os casos em que
   * existe uma resposta única. Fica de fora, sem palpite:
   *
   * - o pedido que não pertence a esta organização (ou que ainda não foi
   *   sincronizado para cá);
   * - o pedido que já tem um título `receber` de OUTRA conta — o banco só
   *   admite um título de cada tipo por pedido, e roubar o vínculo do que já
   *   está lá reescreveria história;
   * - o pedido apontado por MAIS DE UMA conta no mesmo lote (venda parcelada):
   *   escolher uma das parcelas seria arbitrário.
   */
  vincularPedidos(
    scope: VerifiedOrganizationScope,
    candidatos: readonly CandidatoDeVinculo[],
  ): Promise<ReadonlyMap<number, string>>;
  /**
   * Avança o checkpoint da entidade.
   *
   * O handler só chama isto quando **todas** as páginas foram lidas. Marcar
   * depois de uma leitura falha registra um progresso que não houve.
   */
  marcarCheckpoint(scope: VerifiedOrganizationScope, entidade: EntidadeFinanceira): Promise<void>;
}

export interface FinanceiroSyncAuthPort {
  authenticate(request: Request): Promise<{ readonly actorId: string } | null>;
  resolveScope(
    request: Request,
  ): Promise<
    | { readonly _tag: 'Resolved'; readonly scope: VerifiedOrganizationScope }
    | { readonly _tag: 'Denied'; readonly response: NextResponse }
  >;
}

export interface FinanceiroSyncDependencies {
  readonly auth: FinanceiroSyncAuthPort;
  readonly store: FinanceiroSyncStorePort;
  readonly bling: FinanceiroSyncBlingPort;
  /** Teto de páginas por entidade, para uma resposta patológica não girar sem fim. */
  readonly maxPaginas?: number;
}

/**
 * Contagem por entidade.
 *
 * `leituraFalhou` e `leituraIncompleta` são coisas diferentes e as duas
 * impedem o checkpoint: a primeira é o provedor recusando, a segunda é o teto
 * de páginas sendo atingido com a última página cheia — dados ficaram de fora
 * sem ninguém errar. `itensInvalidos` conta o que não passou na validação de
 * contrato e por isso nunca chegou ao repositório.
 */
export interface SyncStats {
  readonly processados: number;
  readonly falhasTemporarias: number;
  readonly falhasPermanentes: number;
  readonly itensInvalidos: number;
  readonly leituraFalhou: boolean;
  readonly leituraIncompleta: boolean;
}

/** Corpo de resposta da rota: `{ success, stats }`, ou `{ success: false, error }`. */
export interface FinanceiroSyncResponseBody {
  readonly success: boolean;
  readonly stats?: {
    readonly contasPagar: SyncStats;
    readonly contasReceber: SyncStats;
  };
  readonly error?: string;
}
