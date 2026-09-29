import { NextResponse } from 'next/server';
import { z } from 'zod';

import {
  STATUS_HTTP_DA_CORRECAO,
  type RespostaDeCorrecao,
} from '@/lib/config/correcaoOperacionalContract';
import type { ContatoRemoto, ExclusaoRemota, LeituraRemota } from '@/lib/integrations/bling/operacaoRemotaContract';
import { registrarFalhaInterna } from '@/lib/observability/falhaInterna';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import { excluirComConfirmacao } from '@/services/exclusaoRemotaConfirmada';

/**
 * `POST /api/clientes/delete` — exclusão de um contato sem histórico.
 *
 * ## A ordem é a garantia
 *
 * 1. escopo verificado e `organization:manage` (quem pode);
 * 2. o cliente é carregado por **`id` + organização do escopo**. O corpo só
 *    traz o `id` local; um `bling_id`, `organizacao_id` ou `user_id` enviado
 *    junto é descartado pelo schema e não tem autoridade nenhuma;
 * 3. as dependências são verificadas **antes** de qualquer efeito no Bling.
 *    Com histórico, a resposta é `Blocked` e nada é tocado — nem o Bling, nem
 *    pedido nenhum;
 * 4. com vínculo no Bling, o contato é **lido primeiro** (`GET /contatos/{id}`):
 *    - `404` → já está ausente; nenhum `DELETE` sai;
 *    - `200` → só então o `DELETE`, confirmado por `excluirComConfirmacao`;
 *    - leitura sem prova → `ReconcileRequired`, sem `DELETE`;
 *    - leitura recusada/limitada → `ProviderRefused`, sem inventar ausência;
 * 5. com a ausência remota provada, as dependências são **classificadas de
 *    novo** — um pedido pode ter surgido durante a chamada ao Bling. Se surgiu,
 *    o cliente local fica (é registro necessário ao histórico) e a resposta diz
 *    que o Bling já foi alterado;
 * 6. a linha local é removida conferindo que **uma** linha saiu.
 *
 * Antes desta versão a rota usava o `bling_id` do navegador, apagava no Bling
 * primeiro e seguia com a exclusão local mesmo com o Bling falhando.
 *
 * ## Repetição
 *
 * Toda tentativa com vínculo começa pela leitura, então **nenhuma repetição
 * começa por outro `DELETE` às cegas** — depois de um `ReconcileRequired`, de
 * uma queda no meio ou de um duplo envio. O que a repetição faz depende do que
 * encontra:
 *
 * - o cliente local já não existe → `NotFound`;
 * - o contato já saiu do Bling e o cliente não tem histórico → conclui a
 *   exclusão local;
 * - o cliente passou a ter histórico (inclusive depois de o contato sair do
 *   Bling) → a pré-checagem já o vê e responde `Blocked` antes de qualquer
 *   chamada ao Bling. Repetir não muda isso, e nenhuma das duas mensagens
 *   convida a repetir.
 *
 * A janela que sobra é estreita: um pedido criado **entre** a segunda
 * classificação e o `DELETE` local. Nela o banco recusa (FK `RESTRICT` e
 * gatilho), e a resposta é classificada de novo em vez de afirmar sucesso.
 */

export interface ClienteParaExclusao {
  readonly id: string;
  /** O `bling_id` **gravado**, e só quando numérico. `null` = contato só do ORBITA. */
  readonly blingId: string | null;
  readonly possuiHistorico: boolean;
}

export interface ExclusaoDeClienteStorePort {
  carregarParaExclusao(scope: VerifiedOrganizationScope, id: string): Promise<ClienteParaExclusao | null>;
  /** Quantas linhas saíram. */
  excluir(scope: VerifiedOrganizationScope, id: string): Promise<number>;
}

export interface ContatoNoBlingPort {
  consultarContato(id: string): Promise<LeituraRemota<ContatoRemoto>>;
  excluirContato(id: string): Promise<ExclusaoRemota>;
}

export interface EventoDeAuditoria {
  readonly acao:
    | 'customer.contact_deleted'
    | 'customer.contact_reconcile_required'
    | 'customer.contact_preserved_after_remote_removal';
  readonly recurso: 'cliente';
  readonly recursoId: string;
  readonly correlationId: string;
  readonly metadata: Readonly<Record<string, string | boolean>>;
}

export interface ExclusaoDeClienteDependencies {
  readonly autorizar: (request: Request) => Promise<
    | { readonly _tag: 'Autorizado'; readonly scope: VerifiedOrganizationScope }
    | { readonly _tag: 'Negado'; readonly response: NextResponse }
  >;
  readonly store: ExclusaoDeClienteStorePort;
  readonly bling: (scope: VerifiedOrganizationScope) => ContatoNoBlingPort;
  readonly auditar: (scope: VerifiedOrganizationScope, evento: EventoDeAuditoria) => Promise<void>;
  readonly correlationId: (request: Request) => string;
}

/** Só o `id`. `strip` (padrão do zod) descarta qualquer outra chave do corpo. */
const corpoSchema = z.object({ id: z.string().uuid() });

function responder(corpo: RespostaDeCorrecao): NextResponse {
  return NextResponse.json(corpo, { status: STATUS_HTTP_DA_CORRECAO[corpo.resultado] });
}

/**
 * Auditoria sem mudar a resposta: a falha dela vai para o log. Depois de um
 * efeito já confirmado, dizer "falhou" faria a pessoa repetir uma exclusão que
 * já aconteceu.
 */
async function auditarSemInterromper(
  deps: ExclusaoDeClienteDependencies,
  scope: VerifiedOrganizationScope,
  evento: EventoDeAuditoria,
): Promise<void> {
  try {
    await deps.auditar(scope, evento);
  } catch (erro: unknown) {
    registrarFalhaInterna(`clientes.excluir.auditoria.${evento.acao}`, erro, { organizacaoId: scope.organizationId });
  }
}

/** Como o Bling ficou, ou a resposta que encerra sem tocar no ORBITA. */
type DesfechoRemoto =
  | { readonly _tag: 'Ausente'; readonly comprovadoPor: 'leitura_inicial' | 'exclusao' | 'leitura_de_confirmacao' }
  | { readonly _tag: 'Resposta'; readonly corpo: RespostaDeCorrecao }
  | { readonly _tag: 'Indeterminado' };

const RECUSADO = { _tag: 'Resposta', corpo: { resultado: 'ProviderRefused', motivo: 'recusado_pelo_bling' } } as const;
const LIMITADO = { _tag: 'Resposta', corpo: { resultado: 'ProviderRefused', motivo: 'limite_de_requisicoes' } } as const;

/**
 * Lê o contato antes de qualquer `DELETE`. Só um `200` libera a exclusão; um
 * `404` já é a ausência, e qualquer leitura sem prova encerra sem `DELETE`.
 */
async function removerDoBling(porta: ContatoNoBlingPort, blingId: string): Promise<DesfechoRemoto> {
  const leitura = await porta.consultarContato(blingId);
  switch (leitura._tag) {
    case 'RemotoAusente':
      return { _tag: 'Ausente', comprovadoPor: 'leitura_inicial' };
    case 'RemotoRecusou':
      return RECUSADO;
    case 'RemotoLimitado':
      return LIMITADO;
    case 'RemotoIndeterminado':
      return { _tag: 'Indeterminado' };
    case 'RemotoPresente':
      break;
  }

  const desfecho = await excluirComConfirmacao({
    excluir: () => porta.excluirContato(blingId),
    consultar: () => porta.consultarContato(blingId),
  });
  switch (desfecho._tag) {
    case 'AusenciaConfirmada':
      return { _tag: 'Ausente', comprovadoPor: desfecho.comprovadaPor === 'exclusao' ? 'exclusao' : 'leitura_de_confirmacao' };
    case 'Recusada':
      return RECUSADO;
    case 'Limitada':
      return LIMITADO;
    case 'RemotoAindaExiste':
      return { _tag: 'Resposta', corpo: { resultado: 'ProviderRefused', motivo: 'exclusao_nao_confirmada' } };
    case 'Indeterminada':
      return { _tag: 'Indeterminado' };
  }
}

/**
 * Com o contato já fora do Bling, o cliente local ganhou histórico: ele fica.
 * A resposta diz que o Bling foi alterado — não "nada mudou". Repetir não tem o
 * que concluir: a pré-checagem da próxima tentativa já vê o histórico e
 * responde `Blocked` sem chamar o Bling.
 */
async function preservarPorHistorico(
  deps: ExclusaoDeClienteDependencies,
  scope: VerifiedOrganizationScope,
  cliente: ClienteParaExclusao & { readonly blingId: string },
  correlationId: string,
): Promise<NextResponse> {
  await auditarSemInterromper(deps, scope, {
    acao: 'customer.contact_preserved_after_remote_removal',
    recurso: 'cliente',
    recursoId: cliente.id,
    correlationId,
    metadata: { bling_id: cliente.blingId, estado_remoto: 'ausente', cliente_local: 'preservado_por_historico' },
  });
  return responder({ resultado: 'Blocked', motivo: 'preservado_por_historico_apos_remocao_no_bling' });
}

/** Remove a linha local e interpreta a recusa do banco pelo estado atual. */
async function concluirLocalmente(
  deps: ExclusaoDeClienteDependencies,
  scope: VerifiedOrganizationScope,
  cliente: ClienteParaExclusao,
  correlationId: string,
  /** Como a ausência no Bling foi provada; ausente para contato só do ORBITA. */
  evidenciaRemota?: 'leitura_inicial' | 'exclusao' | 'leitura_de_confirmacao',
): Promise<NextResponse> {
  let removidas: number;
  try {
    removidas = await deps.store.excluir(scope, cliente.id);
  } catch (erro: unknown) {
    registrarFalhaInterna('clientes.excluir.local', erro, { organizacaoId: scope.organizationId });
    // O banco recusa por FK/gatilho quando um pedido surgiu depois da última
    // classificação. Perguntar de novo em vez de supor.
    const atual = await deps.store.carregarParaExclusao(scope, cliente.id);
    if (!atual) return responder({ resultado: 'NotFound' });
    if (atual.possuiHistorico) {
      return cliente.blingId === null
        ? responder({ resultado: 'Blocked', motivo: 'possui_historico' })
        : preservarPorHistorico(deps, scope, { ...atual, blingId: cliente.blingId }, correlationId);
    }
    if (cliente.blingId === null) throw erro;
    // Sem histórico e com o contato já fora do Bling: a próxima tentativa lê
    // `404` e conclui aqui, sem `DELETE`.
    return responder({ resultado: 'ReconcileRequired', motivo: 'conclusao_local_pendente' });
  }

  if (removidas !== 1) {
    // A linha sumiu entre a carga e a exclusão: outra requisição concluiu
    // antes. Zero linhas não é sucesso desta requisição.
    return responder({ resultado: 'NotFound' });
  }

  await auditarSemInterromper(deps, scope, {
    acao: 'customer.contact_deleted',
    recurso: 'cliente',
    recursoId: cliente.id,
    correlationId,
    metadata: cliente.blingId === null
      ? { removido_do_bling: false }
      : { removido_do_bling: true, bling_id: cliente.blingId, evidencia_remota: evidenciaRemota ?? 'leitura_inicial' },
  });
  return responder({ resultado: 'Deleted', removidoDoBling: cliente.blingId !== null });
}

export function createExclusaoDeClienteHandler(deps: ExclusaoDeClienteDependencies) {
  return async function excluirCliente(request: Request): Promise<NextResponse> {
    const autorizacao = await deps.autorizar(request);
    if (autorizacao._tag === 'Negado') return autorizacao.response;
    const { scope } = autorizacao;

    let corpo: unknown;
    try {
      corpo = await request.json();
    } catch {
      return responder({ resultado: 'InvalidRequest' });
    }
    const lido = corpoSchema.safeParse(corpo);
    if (!lido.success) return responder({ resultado: 'InvalidRequest' });

    const correlationId = deps.correlationId(request);
    const cliente = await deps.store.carregarParaExclusao(scope, lido.data.id);
    if (!cliente) return responder({ resultado: 'NotFound' });
    if (cliente.possuiHistorico) return responder({ resultado: 'Blocked', motivo: 'possui_historico' });

    if (cliente.blingId === null) return concluirLocalmente(deps, scope, cliente, correlationId);

    const blingId = cliente.blingId;
    const remoto = await removerDoBling(deps.bling(scope), blingId);
    if (remoto._tag === 'Resposta') return responder(remoto.corpo);
    if (remoto._tag === 'Indeterminado') {
      await auditarSemInterromper(deps, scope, {
        acao: 'customer.contact_reconcile_required',
        recurso: 'cliente',
        recursoId: cliente.id,
        correlationId,
        metadata: { bling_id: blingId, operacao: 'excluir_contato', estado_remoto: 'indeterminado' },
      });
      return responder({ resultado: 'ReconcileRequired', motivo: 'estado_remoto_indeterminado' });
    }

    // Ausência remota provada. A primeira classificação é de antes da chamada
    // ao Bling; o que vale para apagar a linha local é o estado de agora.
    const atual = await deps.store.carregarParaExclusao(scope, cliente.id);
    if (!atual) return responder({ resultado: 'NotFound' });
    if (atual.possuiHistorico) return preservarPorHistorico(deps, scope, { ...atual, blingId }, correlationId);

    return concluirLocalmente(deps, scope, { ...atual, blingId }, correlationId, remoto.comprovadoPor);
  };
}
