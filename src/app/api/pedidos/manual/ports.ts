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
   * Ticket 30, fatia 3 — reivindica a referência local como uma tentativa
   * nova, ou devolve o desfecho de uma tentativa ANTERIOR com a mesma
   * referência.
   *
   * Chamado ANTES de qualquer chamada ao Bling. Sem isto, uma retentativa —
   * humana, de proxy, de navegador, de qualquer camada — depois de um
   * `PersistVendaAmbigua` não resolvido geraria uma referência nova e criaria
   * um SEGUNDO pedido real no Bling: a mensagem "não tente de novo" não é
   * garantia nenhuma sozinha.
   *
   * **FAIL CLOSED (4ª rodada de revisão).** Se a infraestrutura de
   * idempotência não estiver disponível (a tabela/RPC da migration 59 ainda
   * não existir, ou qualquer outra falha ao reivindicar), devolve
   * `TentativaIndisponivel` — e o handler NÃO chama o Bling. A versão
   * anterior caía para `TentativaNova` nesse caso, o que desligava
   * silenciosamente a proteção exatamente na janela em que o código novo
   * mais precisa dela. Ver `evidence/30-compatibilidade-de-deploy-*.md`: a
   * ordem de deploy recomendada passou a ser migrations primeiro, código
   * depois — não o inverso.
   */
  reivindicarTentativa(
    scope: VerifiedOrganizationScope,
    referenciaLocal: string,
    fingerprint: string,
  ): Promise<ReivindicacaoDeTentativa>;
  /**
   * Grava o desfecho final de uma tentativa já reivindicada.
   *
   * Recebe o escopo porque a RPC é `security definer` — ela ignora RLS, e o
   * predicado de organização dentro dela é a única barreira que resta. A
   * assinatura anterior atualizava só por id (5ª rodada de revisão).
   */
  registrarDesfechoDaTentativa(
    scope: VerifiedOrganizationScope,
    tentativaId: string,
    desfecho: DesfechoDaTentativa,
  ): Promise<void>;
  /**
   * Lê uma tentativa pela referência local, dentro da organização verificada.
   *
   * Usada pela reconciliação (5ª rodada de revisão): uma tentativa
   * `indeterminada` precisa de um caminho de saída que não seja "limpe o
   * localStorage", e para isso é preciso saber em que estado ela está e o que
   * já se sabe dela.
   */
  lerTentativaPorReferencia(
    scope: VerifiedOrganizationScope,
    referenciaLocal: string,
  ): Promise<TentativaRegistrada | null>;
}

/** Uma linha de `tentativas_venda_manual`, como a reconciliação precisa vê-la. */
export interface TentativaRegistrada {
  readonly id: string;
  readonly estado: 'em_andamento' | 'concluida' | 'indeterminada' | 'falhou';
  readonly pedidoId: string | null;
  readonly blingPedidoId: string | null;
  /** Quando a tentativa mudou de estado pela última vez — a idade de uma `em_andamento` travada. */
  readonly atualizadaEm: string;
}

/**
 * O que uma reivindicação de tentativa devolve. `TentativaNova` segue o
 * fluxo normal; os outros cinco casos são situações em que o handler NÃO
 * chama o Bling: três são o desfecho de uma tentativa ANTERIOR com a MESMA
 * venda, `TentativaConflitante` é a mesma chave usada para OUTRA venda, e
 * `TentativaIndisponivel` é a infraestrutura de idempotência não estando
 * disponível — falha fechada, nunca aberta.
 */
export type ReivindicacaoDeTentativa =
  | { readonly _tag: 'TentativaNova'; readonly tentativaId: string }
  | { readonly _tag: 'TentativaConcluida'; readonly pedidoId: string; readonly blingPedidoId: string | null }
  | { readonly _tag: 'TentativaIndeterminada'; readonly blingPedidoId: string | null }
  | { readonly _tag: 'TentativaEmAndamento' }
  /**
   * A referência já existe, mas para uma venda DIFERENTE (5ª rodada de
   * revisão). Não é retentativa: nada executa, e o desfecho da outra operação
   * NÃO é devolvido — devolvê-lo diria "sua venda já foi registrada" sobre uma
   * venda que ninguém registrou.
   */
  | { readonly _tag: 'TentativaConflitante' }
  | { readonly _tag: 'TentativaIndisponivel'; readonly causa: unknown };

export interface DesfechoDaTentativa {
  /**
   * `'falhou'` só é seguro para reabrir a MESMA referência quando o Bling
   * está confirmadamente limpo — ver a máquina de estados em
   * `compensacao.ts`. Uma falha de persistência cuja compensação no Bling
   * também falhou (ou ficou ambígua) grava `'indeterminada'`, não
   * `'falhou'`, porque um pedido pode continuar existindo lá.
   */
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
   * `GET /pedidos/vendas?numerosLojas[]=<referencia>` — procura o pedido pela
   * referência local que o ORBITA enviou em `numeroLoja` na criação.
   *
   * É a peça que torna a reconciliação possível SEM `bling_id` (5ª rodada de
   * revisão): quando `createPedidoVenda` não devolve resposta, o ORBITA não
   * sabe o id do pedido — mas sabe a referência, porque ela foi decidida antes
   * do envio. Perguntar por ela responde a única pergunta que importa: o
   * pedido existe lá, ou não?
   *
   * `null` significa "o Bling respondeu, e não existe pedido com essa
   * referência" — uma resposta NEGATIVA confirmada, diferente de uma falha de
   * consulta, que vem como `BlingFailed`.
   */
  buscarPedidoPorNumeroLoja(numeroLoja: string): Promise<BlingCallResult<PedidoEncontradoNoBling | null>>;
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

/** O que a reconciliação precisa saber de um pedido achado no Bling. */
export interface PedidoEncontradoNoBling {
  readonly id: string;
  readonly numeroLoja: string;
  /** Nome da situação na conta do lojista (`Cancelado`, `Em aberto`, …), quando o Bling a informa. */
  readonly situacao: string | null;
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
