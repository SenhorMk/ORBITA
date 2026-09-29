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
 * 4. com vínculo no Bling, a exclusão lá passa por `excluirComConfirmacao`:
 *    a exclusão local só acontece com **ausência remota confirmada**. Recusa
 *    deixa tudo como estava; resultado sem prova vira `ReconcileRequired`;
 * 5. a linha local é removida conferindo que **uma** linha saiu.
 *
 * Antes desta versão a rota usava o `bling_id` do navegador, apagava no Bling
 * primeiro e seguia com a exclusão local mesmo com o Bling falhando.
 *
 * ## Repetição
 *
 * Pedir de novo é seguro. Se a primeira tentativa já removeu tudo, o cliente
 * não existe mais e a resposta é `NotFound`. Se ela removeu no Bling e parou
 * antes do banco, a segunda carrega o cliente, o `DELETE` recebe `404`, a
 * leitura confirma a ausência e a exclusão local conclui. Nenhum caminho
 * repete uma exclusão sem antes saber o estado remoto.
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
  readonly acao: 'customer.contact_deleted' | 'customer.contact_reconcile_required';
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
 * Auditoria depois de um efeito já confirmado: a falha dela vai para o log e
 * **não** muda a resposta. Dizer "falhou" aqui faria a pessoa repetir uma
 * exclusão que já aconteceu.
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

    if (cliente.blingId !== null) {
      const blingId = cliente.blingId;
      const porta = deps.bling(scope);
      const desfecho = await excluirComConfirmacao({
        excluir: () => porta.excluirContato(blingId),
        consultar: () => porta.consultarContato(blingId),
      });

      switch (desfecho._tag) {
        case 'AusenciaConfirmada':
          break;
        case 'Recusada':
          return responder({ resultado: 'ProviderRefused', motivo: 'recusado_pelo_bling' });
        case 'Limitada':
          return responder({ resultado: 'ProviderRefused', motivo: 'limite_de_requisicoes' });
        case 'RemotoAindaExiste':
          return responder({ resultado: 'ProviderRefused', motivo: 'exclusao_nao_confirmada' });
        case 'Indeterminada':
          await auditarSemInterromper(deps, scope, {
            acao: 'customer.contact_reconcile_required',
            recurso: 'cliente',
            recursoId: cliente.id,
            correlationId,
            metadata: { bling_id: blingId, operacao: 'excluir_contato', estado_remoto: 'indeterminado' },
          });
          return responder({ resultado: 'ReconcileRequired', motivo: 'estado_remoto_indeterminado' });
      }
    }

    let removidas: number;
    try {
      removidas = await deps.store.excluir(scope, cliente.id);
    } catch (erro: unknown) {
      registrarFalhaInterna('clientes.excluir.local', erro, { organizacaoId: scope.organizationId });
      // Sem vínculo no Bling nada aconteceu fora daqui: a recusa do banco
      // (tipicamente um pedido criado depois da checagem) é histórico.
      if (cliente.blingId === null) return responder({ resultado: 'Blocked', motivo: 'possui_historico' });
      // Com vínculo, o contato já saiu do Bling. Dizer "falhou" convidaria a
      // uma repetição cega; o que a pessoa precisa saber é que falta concluir
      // aqui — e repetir é seguro (ver "Repetição" no cabeçalho).
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
        : { removido_do_bling: true, bling_id: cliente.blingId },
    });

    return responder({ resultado: 'Deleted', removidoDoBling: cliente.blingId !== null });
  };
}
