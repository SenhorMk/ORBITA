/**
 * Reconciliação de uma tentativa de venda manual cujo desfecho no Bling não
 * foi confirmado (`indeterminada`, ou `em_andamento` antiga).
 *
 * Bloquear essa tentativa é o comportamento seguro contra duplicação, mas sem
 * um caminho de saída a venda ficaria bloqueada para sempre — e apagar a chave
 * de idempotência no navegador furaria a proteção. Esta é a saída, no servidor.
 *
 * ## Como se pergunta ao Bling sem ter o `bling_id`
 *
 * Quando a resposta da criação se perde, o ORBITA não sabe o id do pedido. Mas
 * sabe a `referenciaLocal`: ela é decidida ANTES do envio e viaja ao Bling em
 * `numeroLoja`. `GET /pedidos/vendas?numerosLojas[]=<referencia>` é filtro
 * oficial da API v3 — ver `docs/integrations/bling-v3-contract.md`.
 *
 * ## Desfechos da consulta
 *
 * | Consulta ao Bling | ORBITA tem a venda? | Resultado | Chave liberada? |
 * |---|---|---|---|
 * | falhou | — | `NaoReconciliavel` (503) | não |
 * | vários pedidos | — | `NaoReconciliavel` (409), conferência manual | não |
 * | nenhum pedido visível | — | `NenhumPedidoVisivel` | **não** |
 * | um pedido | sim | `VendaConfirmada` — só a confirmação se perdeu | sim, com gestão e ledger gravado |
 * | um pedido | não | `PendenteNoBling`, com o `bling_id` descoberto | não |
 *
 * **Ausência não é prova.** O contrato do Bling não garante que um pedido
 * recém-criado já apareça na consulta, então "não encontrei" não significa
 * "não foi criado". `NenhumPedidoVisivel` mantém a tentativa bloqueada.
 *
 * ## Ações
 *
 * - `conferir` (padrão): consulta o Bling e **não escreve no ERP**. Com
 *   `organization:manage` ela escreve no ledger local — assume a posse de uma
 *   tentativa `em_andamento` antiga, registra `concluida` ou guarda o
 *   `bling_id` descoberto. Sem gestão é inspeção pura.
 * - `encerrar-como-nao-criada`: decisão humana explícita de que o pedido não
 *   existe; grava `falhou` e libera a chave. A rota de produção hoje **recusa**
 *   esta ação (`OVERRIDE_ENCERRAR_APROVADO_PELA_PROPRIETARIA`).
 * - `cancelar-no-bling`: **escreve no ERP** — cancela o pedido órfão
 *   (`intervencaoDeCancelamento.ts`).
 * - `resolver-ambiguidade`: registra a decisão humana sobre um cancelamento
 *   cuja resposta não chegou; não chama o Bling.
 *
 * O caso "existe no Bling e não no ORBITA" nunca é resolvido automaticamente:
 * cancelar lá é uma ação explícita de quem gerencia a organização.
 */

import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import { registrarFalhaInterna } from '@/lib/observability/falhaInterna';

import { cancelarNoBlingEEncerrar } from './intervencaoDeCancelamento';
import type { ManualOrderDependencies, TentativaRegistrada } from './ports';
import {
  ledgerNaoGravado,
  resolverAmbiguidade,
  type ResolucaoPedida,
} from './resolucaoDeAmbiguidade';

export type { ResolucaoPedida };

/**
 * O que a reconciliação precisa: ler o ledger, ler o Bling, gravar o desfecho
 * e saber que horas são. Não precisa de `auth` (a rota já resolveu o escopo)
 * nem de `dormir`/`newLocalReference` — pedir só o necessário mantém o teste
 * pequeno e diz, pelo tipo, que esta função não cria vendas nem pedidos.
 */
export type ReconciliacaoDeps = Pick<ManualOrderDependencies, 'store' | 'bling' | 'now'>;

/** Idade mínima para reconciliar uma tentativa ainda `em_andamento`. */
const IDADE_MINIMA_PARA_RECONCILIAR_EM_ANDAMENTO_MS = 2 * 60 * 1000;

/**
 * O que a reconciliação deve FAZER, além de diagnosticar.
 *
 * - `'conferir'` (padrão): consulta o Bling e **nunca escreve no ERP**. Pode
 *   escrever no ledger local (posse, `concluida`, `bling_id` descoberto) se o
 *   ator tiver gestão; sem gestão, não escreve nada.
 * - `'cancelar-no-bling'`: a intervenção operacional explícita para o
 *   desfecho "o pedido existe no Bling e a venda não existe no ORBITA".
 *   **Escreve no ERP** e por isso nunca é o padrão.
 * - `'encerrar-como-nao-criada'`: a decisão HUMANA de que o pedido nunca foi
 *   criado, para o caso em que a consulta não encontra nada. Ela existe
 *   porque **a ausência não é prova**: o contrato do Bling não promete
 *   visibilidade imediata depois de um `POST`, então "o GET não achou agora"
 *   não pode, sozinho, liberar a chave. Quem confere no ERP e conclui que não
 *   existe pedido assume essa conclusão nomeadamente.
 */
export type AcaoDeReconciliacao =
  | 'conferir'
  | 'cancelar-no-bling'
  | 'encerrar-como-nao-criada'
  /**
   * A saída da intervenção `ambigua`. Registra a decisão humana sobre o que de
   * fato aconteceu no ERP. **Não repete o PATCH** — não chama o Bling em
   * momento nenhum.
   */
  | 'resolver-ambiguidade';

/**
 * O que este ator pode FAZER nesta reconciliação.
 *
 * A autorização é pelo EFEITO, não pelo nome da ação: assumir a posse de uma
 * tentativa (avançar a época), escrever no ledger ou tocar no ERP exige
 * `organization:manage`. Sem isso, um `member` poderia cercar um executor
 * legítimo e mudar o desfecho de uma venda. Quem não tem gestão continua
 * podendo INSPECIONAR — não escrever nada e nunca declarar a referência liberada.
 */
export interface PoderesDaReconciliacao {
  readonly podeMutar: boolean;
}

export type ResultadoDaReconciliacao =
  /**
   * A consulta não encontrou pedido — e isso **não** conclui nada. A chave
   * continua bloqueada; encerrar exige a decisão explícita
   * `encerrar-como-nao-criada`.
   */
  | { readonly _tag: 'NenhumPedidoVisivel'; readonly tentativaId: string }
  /** A decisão humana de que nunca houve pedido. Encerra e libera. */
  | { readonly _tag: 'EncerradaComoNaoCriada'; readonly tentativaId: string }
  | { readonly _tag: 'VendaConfirmada'; readonly tentativaId: string; readonly pedidoId: string; readonly blingPedidoId: string }
  /**
   * Inspeção sem poder de gestão: os dois lados têm a venda, mas este ator não
   * pode escrever no ledger — então a referência **não** é declarada liberada.
   * Relatar a verdade observada sem afirmar um efeito que não aconteceu.
   */
  | {
    readonly _tag: 'VendaConfirmadaSemRegistro';
    readonly tentativaId: string;
    readonly pedidoId: string;
    readonly blingPedidoId: string;
  }
  /** A ambiguidade do cancelamento foi encerrada por decisão humana registrada. */
  | { readonly _tag: 'AmbiguidadeResolvida'; readonly tentativaId: string; readonly liberou: boolean }
  | { readonly _tag: 'PendenteNoBling'; readonly tentativaId: string; readonly blingPedidoId: string }
  /** Cancelamento CONFIRMADO no Bling: nada ficou pendente lá, e a chave foi liberada. */
  | { readonly _tag: 'CanceladoNoBling'; readonly tentativaId: string; readonly blingPedidoId: string }
  /**
   * O cancelamento foi despachado e a resposta não chegou. Pode ter acontecido.
   * A intervenção fica `ambigua`, o claim NÃO é liberado, e nenhuma nova
   * mutação sobre este pedido é permitida até alguém descobrir o que houve.
   */
  | { readonly _tag: 'CancelamentoAmbiguo'; readonly tentativaId: string; readonly blingPedidoId: string }
  | { readonly _tag: 'NaoReconciliavel'; readonly motivo: string; readonly status: number };

/**
 * Decide se uma tentativa pode ser reconciliada agora.
 *
 * `em_andamento` recente é uma requisição possivelmente **em voo neste
 * momento** — reconciliar por cima dela concluiria uma tentativa que ainda vai
 * responder. Só depois de uma idade muito maior que a janela de confirmação
 * (~2,8s) e que qualquer timeout de requisição é que "em andamento" significa,
 * de fato, "travada".
 */
export function tentativaPodeSerReconciliada(
  tentativa: TentativaRegistrada,
  agora: Date,
): { readonly pode: true } | { readonly pode: false; readonly motivo: string; readonly status: number } {
  if (tentativa.estado === 'concluida') {
    return { pode: false, motivo: 'Esta venda já está registrada; não há nada a reconciliar.', status: 409 };
  }
  if (tentativa.estado === 'falhou') {
    return { pode: false, motivo: 'Esta tentativa já foi encerrada como não realizada; pode registrar a venda de novo.', status: 409 };
  }
  if (tentativa.estado === 'em_andamento') {
    const idadeMs = agora.getTime() - new Date(tentativa.atualizadaEm).getTime();
    if (idadeMs < IDADE_MINIMA_PARA_RECONCILIAR_EM_ANDAMENTO_MS) {
      return {
        pode: false,
        motivo: 'Esta venda ainda está sendo processada. Aguarde a resposta antes de conferir.',
        status: 409,
      };
    }
  }
  return { pode: true };
}

/**
 * Pergunta ao Bling, pela referência local, o que de fato aconteceu, e executa
 * a ação pedida sobre a tentativa.
 *
 * Fluxo: `resolver-ambiguidade` sai direto → posse (nova época) se a tentativa
 * estiver `em_andamento` → busca por `numeroLoja` → desfecho conforme a tabela
 * do cabeçalho.
 *
 * Efeitos, por ação:
 * - no **Bling**, só `cancelar-no-bling` escreve (via `cancelarNoBlingEEncerrar`);
 * - no **ledger**, só com `poderes.podeMutar`. Uma conclusão gravada é sempre
 *   dedução de uma resposta do provedor ou decisão humana explícita, nunca palpite.
 *
 * Liberar a chave depende de o ledger ter gravado: se a gravação falha, a
 * resposta é `NaoReconciliavel` e nada é declarado liberado.
 */
export async function reconciliarTentativa(
  scope: VerifiedOrganizationScope,
  referenciaLocal: string,
  tentativa: TentativaRegistrada,
  deps: ReconciliacaoDeps,
  acao: AcaoDeReconciliacao = 'conferir',
  poderes: PoderesDaReconciliacao = { podeMutar: true },
  resolucao?: ResolucaoPedida,
): Promise<ResultadoDaReconciliacao> {
  if (acao === 'resolver-ambiguidade') {
    return resolverAmbiguidade(scope, tentativa, deps, resolucao);
  }

  // FENCING. Uma tentativa `em_andamento` antiga pode ter o executor original
  // AINDA VIVO — idade não é sincronização. A reconciliação assume uma nova
  // época antes de escrever; com isso o executor anterior perde a autoridade
  // para concluir a mesma tentativa, e suas escritas são recusadas pelo banco
  // (`55P03`). Cenário exercitado contra Postgres real em
  // `scripts/database-concurrency-fencing.mjs`.
  let epoca = tentativa.epoca;
  if (tentativa.estado === 'em_andamento') {
    // Tomar posse é EFEITO, não leitura: sem gestão, nem começa — senão um
    // `member` cercaria um executor legítimo.
    if (!poderes.podeMutar) {
      return {
        _tag: 'NaoReconciliavel',
        motivo:
          'Esta venda ainda está em execução, e conferi-la exigiria assumi-la — o que só quem administra a '
          + 'organização pode fazer. Peça a conferência a um administrador.',
        status: 403,
      };
    }
    // CAS DE ESTADO + ÉPOCA: a época sozinha não registra que o estado andou;
    // sem o estado esperado, a reconciliação poderia assumir uma tentativa que
    // o handler acabou de concluir na MESMA época.
    const posse = await deps.store.assumirTentativaParaReconciliacao(
      scope,
      tentativa.id,
      tentativa.epoca,
      tentativa.estado,
    );
    if (posse._tag === 'PosseNegada') {
      return {
        _tag: 'NaoReconciliavel',
        motivo: 'Esta venda mudou de estado enquanto era conferida. Confira de novo para ver a situação atual.',
        status: 409,
      };
    }
    if (posse._tag === 'PosseIndisponivel') {
      registrarFalhaInterna('pedidos.manual.reconciliar.posse', posse.causa);
      return {
        _tag: 'NaoReconciliavel',
        motivo: 'Não foi possível assumir esta venda para conferência agora. Tente de novo em instantes.',
        status: 503,
      };
    }
    epoca = posse.epoca;
  }

  const busca = await deps.bling.buscarPedidoPorNumeroLoja(referenciaLocal);

  if (busca._tag === 'BlingFailed') {
    registrarFalhaInterna('pedidos.manual.reconciliar.busca', new Error(busca.failure.message));
    return {
      _tag: 'NaoReconciliavel',
      motivo: 'Não foi possível consultar o Bling agora. A venda continua bloqueada de propósito; tente conferir de novo em instantes.',
      status: 503,
    };
  }

  const encontrado = busca.value;

  // CARDINALIDADE EXPLÍCITA. Mais de um pedido com a MESMA referência não
  // deveria existir, e por isso mesmo não pode ser resolvido escolhendo "o
  // primeiro": associar a tentativa ao pedido errado conclui a venda errada.
  if (encontrado._tag === 'VariosPedidos') {
    registrarFalhaInterna(
      'pedidos.manual.reconciliar.varios',
      new Error(`${encontrado.quantidade} pedidos no Bling com a mesma referência: ${encontrado.ids.join(', ')}`),
    );
    return {
      _tag: 'NaoReconciliavel',
      motivo:
        `Foram encontrados ${encontrado.quantidade} pedidos no Bling com esta mesma referência. `
        + 'Não é possível concluir automaticamente qual deles corresponde a esta venda — '
        + 'a tentativa continua bloqueada e precisa de conferência manual no Bling.',
      status: 409,
    };
  }

  if (encontrado._tag === 'NenhumPedido') {
    // AUSÊNCIA NÃO É PROVA.
    //
    // Tratar "o GET não achou" como "o POST nunca criou" exigiria uma garantia
    // de read-after-write que **o contrato do Bling não dá**: o OpenAPI oficial
    // não menciona consistência, propagação ou visibilidade.
    //
    // Sem essa garantia, liberar aqui reabriria a chave numa janela em que o
    // pedido pode existir e ainda não estar visível — e a retentativa criaria o
    // segundo. Então a conferência **não conclui nada** neste caso: relata a
    // ausência e mantém o bloqueio.
    if (acao !== 'encerrar-como-nao-criada') {
      return { _tag: 'NenhumPedidoVisivel', tentativaId: tentativa.id };
    }

    // A decisão humana, pedida nomeadamente: alguém conferiu no ERP e assume
    // que o pedido não existe. Só então a chave é liberada — e só se o
    // registro dessa liberação for durável.
    const registro = await deps.store.registrarDesfechoDaTentativa(
      scope,
      tentativa.id,
      { estado: 'falhou' },
      undefined,
      epoca,
    );
    if (registro._tag === 'DesfechoNaoGravado') return ledgerNaoGravado(registro.causa);
    return { _tag: 'EncerradaComoNaoCriada', tentativaId: tentativa.id };
  }

  const pedidoNoBling = encontrado.pedido;
  const jaRegistrada = await deps.store.findVendaManualJaRegistrada(scope, pedidoNoBling.id);
  if (jaRegistrada !== null) {
    // Os dois lados têm a venda: o que se perdeu foi só a confirmação.
    if (!poderes.podeMutar) {
      return {
        _tag: 'VendaConfirmadaSemRegistro',
        tentativaId: tentativa.id,
        pedidoId: jaRegistrada.pedidoId,
        blingPedidoId: pedidoNoBling.id,
      };
    }
    // Sem FALSO SUCESSO: `VendaConfirmada` só sai se esta gravação persistir.
    // Declarar liberada uma referência que o ledger não liberou convidaria a
    // próxima duplicação.
    const registro = await deps.store.registrarDesfechoDaTentativa(
      scope,
      tentativa.id,
      { estado: 'concluida', pedidoId: jaRegistrada.pedidoId, blingPedidoId: pedidoNoBling.id },
      undefined,
      epoca,
    );
    if (registro._tag === 'DesfechoNaoGravado') return ledgerNaoGravado(registro.causa);
    return {
      _tag: 'VendaConfirmada',
      tentativaId: tentativa.id,
      pedidoId: jaRegistrada.pedidoId,
      blingPedidoId: pedidoNoBling.id,
    };
  }

  // O pedido existe no Bling e a venda não existe aqui — o único desfecho que
  // a conferência não resolve sozinha. Com gestão, grava o `bling_id`
  // descoberto (mantendo `indeterminada`): é ele que torna a resolução
  // possível. Esta gravação é best-effort — seu resultado não é conferido.
  // Sem gestão, nada é gravado; a inspeção relata o que viu.
  if (poderes.podeMutar) {
    await deps.store.registrarDesfechoDaTentativa(
      scope,
      tentativa.id,
      { estado: 'indeterminada', blingPedidoId: pedidoNoBling.id },
      undefined,
      epoca,
    );
  }

  if (acao !== 'cancelar-no-bling') {
    return { _tag: 'PendenteNoBling', tentativaId: tentativa.id, blingPedidoId: pedidoNoBling.id };
  }

  return cancelarNoBlingEEncerrar(scope, tentativa, pedidoNoBling.id, deps, epoca);
}
