/**
 * Portas e tipos da venda manual (`POST /api/pedidos/manual`) e da reconciliação.
 *
 * O handler depende destas interfaces, não do Supabase nem do Bling: os
 * adapters de produção ficam em `dependencias.ts` e
 * `dependenciasDeReconciliacao.ts`, e os testes montam dublês completos.
 * As regras de concorrência (claim, época, CAS, imutabilidade das
 * intervenções) são impostas pelas RPCs e constraints do banco.
 */
import type { NextResponse } from 'next/server';

import type { BlingCallResult, BuscaDePedidoPorNumeroLoja } from '@/lib/integrations/bling/pedidoVendaContract';
import type { Dormir } from '@/services/filaDeRequisicoes';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import type { ManualOrderBlingPort } from './portsDoBling';
import type {
  FinalizacaoDeIntervencao,
  FinalizacaoResultado,
  PosseDaTentativa,
  RegistroDeDesfecho,
  ReivindicacaoDeIntervencao,
  ResolucaoDeAmbiguidade,
  ResolucaoDeIntervencaoAmbigua,
  TomadaDePosse,
} from './portsDeReconciliacao';

export type { Dormir };

export type {
  DecisaoDeAmbiguidade,
  FinalizacaoDeIntervencao,
  FinalizacaoResultado,
  PosseDaTentativa,
  RegistroDeDesfecho,
  ReivindicacaoDeIntervencao,
  ResolucaoDeAmbiguidade,
  ResolucaoDeIntervencaoAmbigua,
  TomadaDePosse,
} from './portsDeReconciliacao';

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
  /**
   * A tentativa que autoriza esta gravação, e a época em que ela foi
   * reivindicada.
   *
   * Não são metadados: a RPC recusa a gravação inteira se a posse já tiver
   * mudado. É o que impede um executor cercado de commitar a venda depois de
   * a reconciliação já ter cancelado o pedido no Bling.
   */
  readonly tentativaId: string;
  readonly epoca: number;
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
 * Desfecho de `persistVenda`. As falhas são separadas em dois casos porque "a
 * chamada lançou" mistura duas situações que exigem reações opostas:
 *
 * - `PersistVendaOk` — a venda foi gravada, com o id do pedido local.
 * - `PersistVendaFalhouDefinitivamente` — o servidor **respondeu** com um erro
 *   estruturado cujo código está na allowlist de `classificacaoDeFalha.ts`.
 *   Uma resposta assim só existe
 *   depois que o servidor terminou de processar a requisição — a transação já
 *   foi revertida. É seguro compensar.
 * - `PersistVendaAmbigua` — a chamada falhou **sem** resposta reconhecida do
 *   servidor (timeout, conexão perdida, abort, código fora da allowlist).
 *   Não há como saber, só por
 *   isso, se a transação chegou a commitar antes da falha aparecer do lado do
 *   cliente. Compensar aqui pode cancelar no Bling uma venda que está, neste
 *   exato momento, sendo gravada com sucesso do outro lado.
 */
export type PersistVendaResult =
  | { readonly _tag: 'PersistVendaOk'; readonly pedidoId: string }
  | { readonly _tag: 'PersistVendaFalhouDefinitivamente'; readonly causa: unknown }
  | { readonly _tag: 'PersistVendaAmbigua'; readonly causa: unknown }
  /**
   * A posse da tentativa já não é de quem chamou (`55P03`).
   * **Nada foi gravado** — a RPC recusa antes de qualquer efeito, com a linha
   * da tentativa travada. Não é falha a compensar: quem tomou a posse é quem
   * decide o desfecho, e escrever qualquer coisa daqui seria escrever por cima
   * de uma decisão alheia.
   */
  | { readonly _tag: 'PersistVendaSemPosse' };

/**
 * Persistência da venda manual e do ledger de tentativas. `persistVenda` é uma
 * operação só porque pedido, itens, baixa de estoque e título financeiro
 * precisam cair juntos, na mesma transação do banco.
 */
export interface ManualOrderStorePort {
  findClienteById(scope: VerifiedOrganizationScope, clienteId: string): Promise<ManualOrderCliente | null>;
  linkClienteBlingId(scope: VerifiedOrganizationScope, clienteId: string, blingId: string): Promise<void>;
  findProdutosByIds(scope: VerifiedOrganizationScope, produtoIds: readonly string[]): Promise<readonly ManualOrderProduto[]>;
  /**
   * Não deve lançar — `PersistVendaResult` é o valor, não a exceção, porque o
   * handler precisa **distinguir** os desfechos acima para
   * decidir se pode compensar. Um `throw` apaga essa distinção antes mesmo de
   * ela chegar ao chamador.
   */
  persistVenda(input: PersistManualOrderInput): Promise<PersistVendaResult>;
  /**
   * Recuperação de confirmação perdida.
   *
   * Confere se a venda já foi de fato registrada, por `bling_id` + origem.
   * Chamado antes de compensar (cancelar no Bling) sempre que o resultado de
   * `persistVenda` não é `PersistVendaOk`: se a venda já existe, cancelar
   * seria destrutivo — apagaria no ERP uma venda que já é real e completa no
   * ORBITA.
   */
  findVendaManualJaRegistrada(scope: VerifiedOrganizationScope, blingPedidoId: string): Promise<{ readonly pedidoId: string } | null>;
  /**
   * CLAIM: reivindica a referência local como uma tentativa nova, ou devolve o
   * desfecho de uma tentativa ANTERIOR com a mesma referência.
   *
   * Chamado ANTES de qualquer chamada ao Bling. Sem isto, uma retentativa —
   * humana, de proxy, de navegador — depois de um desfecho não resolvido
   * poderia criar um SEGUNDO pedido real no Bling: a mensagem "não tente de
   * novo" sozinha não protege nada.
   *
   * **FAIL CLOSED.** Se a infraestrutura de idempotência não estiver disponível
   * (a tabela/RPC da migration 59 ainda não existir, ou qualquer outra falha ao
   * reivindicar), devolve `TentativaIndisponivel` — e o handler NÃO chama o
   * Bling. Por isso a ordem de deploy é migrations primeiro, código depois.
   */
  reivindicarTentativa(
    scope: VerifiedOrganizationScope,
    referenciaLocal: string,
    fingerprint: string,
    valoresFingerprint: string,
  ): Promise<ReivindicacaoDeTentativa>;
  /**
   * Grava o desfecho final de uma tentativa já reivindicada.
   *
   * Recebe o escopo porque a RPC é `security definer` — ela ignora RLS, e o
   * predicado de organização dentro dela é a barreira entre organizações.
   * Uma escrita recusada pela RPC volta como `DesfechoNaoGravado`, não como exceção.
   */
  registrarDesfechoDaTentativa(
    scope: VerifiedOrganizationScope,
    tentativaId: string,
    desfecho: DesfechoDaTentativa,
    /**
     * Compare-and-set de estado. Quando informado, a escrita só acontece se o
     * estado atual for exatamente este.
     *
     * O handler passa `'em_andamento'` ao gravar `falhou` ou `indeterminada`:
     * um desfecho que rebaixa não pode passar por cima de uma tentativa que já
     * mudou de estado. Grava `concluida` sem CAS de estado, porque escrever
     * `concluida` sobre `concluida` é idempotente. A reconciliação não passa
     * estado: ela já assumiu a posse, e a época é o que a protege.
     */
    estadoEsperado?: TentativaRegistrada['estado'],
    /**
     * Fencing token. Quem escreve apresenta a época que recebeu ao reivindicar
     * ou ao assumir a posse; se a tentativa foi tomada nesse meio-tempo, a
     * escrita é RECUSADA em vez de gravar por cima. **Idade não é
     * sincronização.**
     */
    epocaEsperada?: number,
  ): Promise<RegistroDeDesfecho>;
  /**
   * Confere se a época apresentada ainda é a vigente.
   *
   * Chamada imediatamente antes de criar o pedido no Bling (e, na preparação
   * do envio, antes de cadastrar o contato). Não fecha a janela entre esta
   * resposta e o envio HTTP — a posse pode mudar nesse intervalo, e nenhum
   * mecanismo local fecha essa janela —, mas evita que um executor que já
   * sabidamente perdeu a posse inicie um efeito novo. O efeito local durável
   * tem proteção mais forte: `persistVenda` confere a época dentro da mesma
   * transação do banco que grava a venda.
   */
  confirmarPosse(
    scope: VerifiedOrganizationScope,
    tentativaId: string,
    epoca: number,
  ): Promise<PosseDaTentativa>;
  /**
   * Toma a posse de uma tentativa antiga para reconciliar. Avança a época,
   * cercando o executor anterior. Devolve a época nova.
   *
   * O estado esperado entra junto com a época: a época sozinha não registra
   * que o estado andou, e sem ele uma reconciliação poderia assumir uma
   * tentativa que o handler acabou de concluir na MESMA época.
   */
  assumirTentativaParaReconciliacao(
    scope: VerifiedOrganizationScope,
    tentativaId: string,
    epocaEsperada: number,
    estadoEsperado: TentativaRegistrada['estado'],
  ): Promise<TomadaDePosse>;
  /**
   * Encerra, com decisão humana registrada, uma intervenção que ficou
   * `ambigua`.
   *
   * **Não chama o ERP.** A pessoa foi ao Bling, olhou a situação real do
   * pedido e afirma o que viu. O fato original continua `ambigua` (um trigger
   * do banco impede reescrevê-lo), e a decisão nova é registrada com ator e
   * evidência próprios.
   */
  resolverIntervencaoAmbigua(input: ResolucaoDeIntervencaoAmbigua): Promise<ResolucaoDeAmbiguidade>;
  /**
   * Finaliza tentativa e intervenção numa única RPC, isto é, numa transação só
   * do banco.
   *
   * Depois de um efeito externo, a gravação local não pode ser fire-and-forget:
   * se falhar, a resposta não pode dizer que a referência foi liberada. As duas
   * linhas locais valem juntas ou nenhuma vale, e o chamador sabe. O efeito no
   * Bling fica fora dessa transação.
   */
  finalizarIntervencaoETentativa(input: FinalizacaoDeIntervencao): Promise<FinalizacaoResultado>;
  /**
   * Reivindica o direito de executar uma intervenção operacional sobre a
   * tentativa.
   *
   * É um CLAIM, não um log: no máximo uma intervenção sem desfecho (ou
   * `ambigua`) por tentativa, imposto por índice único parcial do banco. Duas
   * requisições simultâneas de cancelamento sobre a mesma tentativa não
   * produzem duas chamadas ao ERP — e isso **não** se apoia em "cancelar duas
   * vezes é inócuo", que o contrato do Bling não afirma.
   */
  reivindicarIntervencao(
    scope: VerifiedOrganizationScope,
    tentativaId: string,
    acao: 'cancelar-no-bling',
    blingPedidoId: string | null,
  ): Promise<ReivindicacaoDeIntervencao>;
  /**
   * Fecha o registro de intervenção com o desfecho; depois disso um trigger do
   * banco impede alterá-lo. Os fluxos atuais usam `finalizarIntervencaoETentativa`;
   * esta operação existe no adapter, mas não tem chamador.
   */
  encerrarIntervencao(
    scope: VerifiedOrganizationScope,
    intervencaoId: string,
    resultado: 'confirmada' | 'falhou' | 'ambigua',
    detalhe: string | null,
  ): Promise<void>;
  /**
   * Lê uma tentativa pela referência local, dentro da organização verificada.
   *
   * Usada pela reconciliação: uma tentativa
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
  /** Época vigente: quem não a apresenta nas escritas deixou de ser dono. */
  readonly epoca: number;
}

/**
 * O que uma reivindicação de tentativa devolve. `TentativaNova` segue o
 * fluxo normal; nos outros sete casos o handler NÃO chama o Bling:
 * `TentativaConcluida`, `TentativaIndeterminada` e `TentativaEmAndamento` são o
 * estado de uma tentativa ANTERIOR com a mesma referência;
 * `TentativaConflitante`, `TentativaComValoresDivergentes` e
 * `TentativaComPendenciaIdentica` são conflitos de conteúdo; e
 * `TentativaIndisponivel` é a infraestrutura de idempotência não respondendo —
 * falha fechada.
 */
export type ReivindicacaoDeTentativa =
  | { readonly _tag: 'TentativaNova'; readonly tentativaId: string; readonly epoca: number }
  | { readonly _tag: 'TentativaConcluida'; readonly pedidoId: string; readonly blingPedidoId: string | null }
  | { readonly _tag: 'TentativaIndeterminada'; readonly blingPedidoId: string | null }
  | { readonly _tag: 'TentativaEmAndamento' }
  /**
   * A referência já existe, mas para uma venda DIFERENTE. Não é retentativa: nada executa, e o desfecho da outra operação
   * NÃO é devolvido — devolvê-lo diria "sua venda já foi registrada" sobre uma
   * venda que ninguém registrou.
   */
  | { readonly _tag: 'TentativaConflitante' }
  /**
   * A venda pedida é a mesma, mas os VALORES resolvidos no servidor mudaram
   * entre as tentativas. Uma tentativa `falhou` não
   * reabre em silêncio executando o preço novo — quem confirmou a venda
   * confirmou um total, e esse total mudou.
   */
  | { readonly _tag: 'TentativaComValoresDivergentes' }
  /**
   * Existe OUTRA tentativa sem desfecho para exatamente esta mesma venda. Não dá para saber, do servidor, se esta submissão é a
   * mesma venda tentada de novo por um cliente que perdeu a referência, ou uma
   * segunda venda legitimamente idêntica — então nenhuma das duas: recusa e
   * aponta a pendência, para ser resolvida antes.
   */
  | { readonly _tag: 'TentativaComPendenciaIdentica'; readonly referenciaPendente: string }
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

export type { BlingCallResult, BuscaDePedidoPorNumeroLoja };
export type { ManualOrderBlingPort } from './portsDoBling';

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
   * Sem UUID do cliente, gera um novo — e essa submissão fica sem proteção
   * entre retentativas.
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
