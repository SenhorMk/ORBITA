/**
 * Portas e tipos da venda manual (`POST /api/pedidos/manual`).
 *
 * Separado de `handler.ts` para manter cada arquivo dentro do limite de
 * tamanho do gate de qualidade e para que o adapter Supabase da rota importe
 * apenas o contrato, sem depender da lógica do handler.
 */
import type { NextResponse } from 'next/server';

import type { BlingCallResult, PedidoVendaPayload } from '@/lib/integrations/bling/pedidoVendaContract';
import type { Dormir } from '@/services/filaDeRequisicoes';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';

export type { Dormir };

/** Cliente do ORBITA já lido dentro do escopo verificado da organização. */
export interface ManualOrderCliente {
  readonly id: string;
  readonly nome: string;
  readonly blingId: string | null;
  readonly email: string | null;
  readonly telefone: string | null;
  readonly cpfCnpj: string | null;
}

/** Produto já lido dentro do escopo verificado, com o preço em que o servidor confia. */
export interface ManualOrderProduto {
  readonly id: string;
  readonly nome: string;
  readonly codigo: string | null;
  readonly blingId: string | null;
  readonly preco: number;
  readonly estoqueDisponivel: number;
}

/** Item já resolvido: quantidade pedida somada ao produto do cadastro. */
export interface ResolvedManualOrderItem {
  readonly produto: ManualOrderProduto;
  readonly quantidade: number;
}

export interface PersistManualOrderInput {
  readonly scope: VerifiedOrganizationScope;
  readonly clienteId: string;
  readonly blingPedidoId: string | null;
  readonly referenciaLocal: string;
  readonly total: number;
  readonly desconto: number;
  readonly frete: number;
  readonly formaPagamento: string | null;
  readonly observacoes: string | null;
  readonly dataStr: string;
  readonly itens: readonly ResolvedManualOrderItem[];
}

/**
 * Desfecho de `persistVenda` (ticket 30, fatia 3 — retentativa após resposta
 * perdida). Três casos, não dois, porque "a chamada lançou" mistura duas
 * situações que exigem reações opostas:
 *
 * - `PersistVendaOk` — a venda foi gravada, com o id do pedido local.
 * - `PersistVendaFalhouDefinitivamente` — o servidor **respondeu** com um erro
 *   estruturado (código SQL/PostgREST não vazio). Uma resposta assim só existe
 *   depois que o servidor terminou de processar a requisição — a transação já
 *   foi revertida. É seguro compensar.
 * - `PersistVendaAmbigua` — a chamada falhou **sem** resposta estruturada do
 *   servidor (timeout, conexão perdida, abort). Não há como saber, só por
 *   isso, se a transação chegou a commitar antes da falha aparecer do lado do
 *   cliente. Compensar aqui pode cancelar no Bling uma venda que está, neste
 *   exato momento, sendo gravada com sucesso do outro lado.
 */
export type PersistVendaResult =
  | { readonly _tag: 'PersistVendaOk'; readonly pedidoId: string }
  | { readonly _tag: 'PersistVendaFalhouDefinitivamente'; readonly causa: unknown }
  | { readonly _tag: 'PersistVendaAmbigua'; readonly causa: unknown };

/**
 * Persistência da venda manual. É uma porta única de propósito porque pedido,
 * itens, baixa de estoque e título financeiro precisam cair juntos — a versão
 * anterior espalhava esses quatro efeitos pelo handler e deixava o título
 * financeiro sem `organizacao_id`.
 */
export interface ManualOrderStorePort {
  findClienteById(scope: VerifiedOrganizationScope, clienteId: string): Promise<ManualOrderCliente | null>;
  linkClienteBlingId(scope: VerifiedOrganizationScope, clienteId: string, blingId: string): Promise<void>;
  findProdutosByIds(scope: VerifiedOrganizationScope, produtoIds: readonly string[]): Promise<readonly ManualOrderProduto[]>;
  /**
   * Nunca lança — `PersistVendaResult` é o valor, não a exceção, exatamente
   * porque o handler precisa **distinguir** os três desfechos acima para
   * decidir se pode compensar. Um `throw` apaga essa distinção antes mesmo de
   * ela chegar ao chamador.
   */
  persistVenda(input: PersistManualOrderInput): Promise<PersistVendaResult>;
  /**
   * Ticket 30, fatia 3 — recuperação de confirmação perdida.
   *
   * Confere se a venda já foi de fato registrada, por `bling_id` + origem.
   * Chamado antes de compensar (cancelar no Bling) sempre que o resultado de
   * `persistVenda` não é `PersistVendaOk`: se a venda já existe, cancelar
   * seria destrutivo — apagaria no ERP uma venda que já é real e completa no
   * ORBITA.
   */
  findVendaManualJaRegistrada(scope: VerifiedOrganizationScope, blingPedidoId: string): Promise<{ readonly pedidoId: string } | null>;
  /**
   * Ticket 30, fatia 3, endurecida na 3ª rodada — reivindica a referência
   * local como uma tentativa nova, ou devolve o desfecho de uma tentativa
   * ANTERIOR com a mesma referência.
   *
   * Chamado ANTES de qualquer chamada ao Bling. Sem isto, uma retentativa —
   * humana, de proxy, de navegador, de qualquer camada — depois de um
   * `PersistVendaAmbigua` não resolvido geraria uma referência nova e criaria
   * um SEGUNDO pedido real no Bling: a mensagem "não tente de novo" não é
   * garantia nenhuma sozinha.
   *
   * Se a tabela ainda não existir no banco (migration 59 não aplicada — a
   * migration e o código deste PR não têm ordem de deploy garantida),
   * devolve `TentativaNova` em vez de lançar: a proteção fica ausente, não
   * quebra a venda. Ver `evidence/30-compatibilidade-de-deploy-*.md`.
   */
  reivindicarTentativa(scope: VerifiedOrganizationScope, referenciaLocal: string): Promise<ReivindicacaoDeTentativa>;
  /** Grava o desfecho final de uma tentativa já reivindicada. */
  registrarDesfechoDaTentativa(tentativaId: string, desfecho: DesfechoDaTentativa): Promise<void>;
}

/**
 * O que uma reivindicação de tentativa devolve. `TentativaNova` segue o
 * fluxo normal; os outros três casos são o desfecho de uma tentativa
 * ANTERIOR com a mesma referência local, e o handler nunca chama o Bling de
 * novo para eles.
 */
export type ReivindicacaoDeTentativa =
  | { readonly _tag: 'TentativaNova'; readonly tentativaId: string }
  | { readonly _tag: 'TentativaConcluida'; readonly pedidoId: string; readonly blingPedidoId: string | null }
  | { readonly _tag: 'TentativaIndeterminada'; readonly blingPedidoId: string | null }
  | { readonly _tag: 'TentativaEmAndamento' };

export interface DesfechoDaTentativa {
  readonly estado: 'concluida' | 'indeterminada' | 'falhou';
  readonly pedidoId?: string;
  readonly blingPedidoId?: string | null;
}

export type { BlingCallResult };

export interface ManualOrderBlingPort {
  /** `GET /formas-pagamentos` — a forma marcada como padrão na conta do proprietário. */
  getDefaultFormaPagamentoId(): Promise<BlingCallResult<number>>;
  /** `POST /contatos` — usado quando o cliente local ainda não tem cadastro no Bling. */
  createContato(input: {
    nome: string;
    email: string | null;
    telefone: string | null;
    documento: string | null;
  }): Promise<BlingCallResult<{ id: number }>>;
  /** `POST /pedidos/vendas` — o payload já vem validado contra o schema oficial. */
  createPedidoVenda(payload: PedidoVendaPayload): Promise<BlingCallResult<{ id: string; alertas: readonly string[] }>>;
  /** `POST /pedidos/vendas/{id}/lancar-estoque` — baixa vinculada ao pedido, no depósito padrão. */
  lancarEstoquePedido(pedidoBlingId: string): Promise<BlingCallResult<void>>;
  /**
   * Compensação: marca como cancelado um pedido que o Bling aceitou e o ORBITA
   * não conseguiu gravar.
   *
   * Cancelar, e não apagar. Apagar destruiria o rastro de que a venda chegou a
   * existir no ERP; cancelado é um estado legítimo que diz "isto não vale", e
   * a sincronização traz o pedido cancelado para cá — os dois lados convergem
   * em vez de um esquecer.
   */
  cancelarPedidoVenda(pedidoBlingId: string): Promise<BlingCallResult<void>>;
}

export interface ManualOrderAuthPort {
  /** Identidade do ator derivada da sessão verificada. `null` recusa a requisição. */
  authenticate(request: Request): Promise<{ readonly actorId: string } | null>;
  /** Organização provada contra a associação persistida, nunca vinda do cliente. */
  resolveScope(
    request: Request,
  ): Promise<
    | { readonly _tag: 'Resolved'; readonly scope: VerifiedOrganizationScope }
    | { readonly _tag: 'Denied'; readonly response: NextResponse }
  >;
}

export interface ManualOrderDependencies {
  readonly auth: ManualOrderAuthPort;
  readonly store: ManualOrderStorePort;
  readonly bling: ManualOrderBlingPort;
  readonly now: () => Date;
  /**
   * Monta `ORBITA-<uuid>`. Recebe o UUID que o cliente enviou em
   * `referenciaLocal`, quando presente — para que uma retentativa da mesma
   * submissão gere a MESMA referência, e `reivindicarTentativa` a reconheça.
   * Sem UUID do cliente, gera um novo, como sempre fez.
   */
  readonly newLocalReference: (referenciaClienteFornecida?: string) => string;
  /** Espera entre tentativas de confirmar uma `PersistVendaAmbigua`. Ver `Dormir`. */
  readonly dormir: Dormir;
}

/** Corpo de resposta da rota, consumido pelo `ManualOrderModal`. */
export interface ManualOrderResponseBody {
  readonly success: boolean;
  readonly pedidoId?: string;
  readonly blingPedidoId?: string | null;
  readonly total?: number;
  /** Falhas parciais que não invalidam a venda, mas que o usuário precisa ver. */
  readonly avisos?: readonly string[];
  readonly error?: string;
  /** `true` quando o Bling recusou por venda idêntica à última salva. */
  readonly vendaDuplicada?: boolean;
  /**
   * Só aparece quando a gravação local falhou depois de o Bling aceitar.
   *
   * `true`  — o pedido remoto foi cancelado; nada ficou pendente lá.
   * `false` — o cancelamento também falhou e alguém precisa agir no Bling.
   *
   * A distinção é o que separa "pode tentar de novo" de "não tente de novo
   * antes de limpar", e é a diferença entre uma retentativa segura e mais um
   * pedido órfão na conta do lojista.
   */
  readonly compensado?: boolean;
  /**
   * `true` só quando a gravação falhou de um jeito que **não dá para
   * resolver do lado do cliente**: a chamada não teve resposta estruturada do
   * servidor (timeout/conexão perdida), e a checagem de confirmação, mesmo
   * repetida, não achou nem descartou a venda dentro da janela de espera.
   *
   * Não compensa neste caso — cancelar no Bling arriscaria destruir uma venda
   * que pode estar sendo gravada com sucesso neste exato momento do outro
   * lado. `compensado` fica ausente: não houve tentativa de compensação, não
   * "tentou e falhou".
   */
  readonly estadoIndeterminado?: boolean;
}
