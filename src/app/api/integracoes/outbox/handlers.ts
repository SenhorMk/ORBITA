import { NextResponse } from 'next/server';
import { z } from 'zod';

import {
  DecisaoDaOutboxSchema,
  RespostaDaOutboxSchema,
  VERSAO_DO_CONTRATO_DA_OUTBOX,
} from '@/lib/integrations/contratoDaOutbox';
import {
  organizationContextStatus,
  type OrganizationContextResult,
} from '@/lib/organizationAuthorization';
import { organizationContextToScope, type VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import type { DecisaoOutbox, EventoComAtencao, FalhaDeDecisaoOutbox } from '@/services/outbox/decisoesDaOutbox';

/** As fronteiras que a rota usa; produção liga o Supabase, o teste liga fakes. */
export interface DependenciasDaOutbox {
  readonly resolverContexto: (request: Request) => Promise<OrganizationContextResult>;
  readonly listar: (scope: VerifiedOrganizationScope) => Promise<readonly EventoComAtencao[]>;
  readonly autorizarReplay: (scope: VerifiedOrganizationScope, eventoId: string) => Promise<DecisaoOutbox>;
  readonly resolver: (
    scope: VerifiedOrganizationScope,
    eventoId: string,
    entrada: { readonly resolucao: 'confirmado' | 'provado_nao_aplicado' | 'revisao_manual'; readonly reciboRef?: string; readonly evidencia?: string },
  ) => Promise<DecisaoOutbox>;
  /** Trilha da decisão humana. Metadata: id, ação e desfecho; nunca o recibo ou a evidência. */
  readonly auditar: (scope: VerifiedOrganizationScope, acao: string, eventoId: string, metadata: Record<string, unknown>) => Promise<void>;
}

function negado(contexto: Exclude<OrganizationContextResult, { _tag: 'OrganizationContextResolved' }>) {
  const status = organizationContextStatus(contexto);
  return NextResponse.json(
    { success: false, error: status === 503 ? 'Serviço de autorização indisponível' : 'Não autorizado' },
    { status },
  );
}

const STATUS_DA_FALHA: Readonly<Record<FalhaDeDecisaoOutbox, number>> = {
  SemPapel: 403,
  NaoEncontrado: 404,
  EstadoNaoAdmite: 409,
  EntradaInvalida: 400,
};

const MENSAGEM_DA_FALHA: Readonly<Record<FalhaDeDecisaoOutbox, string>> = {
  SemPapel: 'Só owner ou admin decide sobre um envio.',
  NaoEncontrado: 'Envio não encontrado.',
  EstadoNaoAdmite: 'Este envio não admite a decisão: sem prova de que o provedor não aplicou, ele não pode ser repetido.',
  EntradaInvalida: 'Dados da decisão inválidos.',
};

/** Consulta de efeitos que pedem atenção e das tentativas, só da organização da sessão. */
export function criarConsultaDaOutbox(deps: DependenciasDaOutbox) {
  return async function consultar(request: Request) {
    const contexto = await deps.resolverContexto(request);
    if (contexto._tag !== 'OrganizationContextResolved') return negado(contexto);
    const scope = organizationContextToScope(contexto.context);
    const corpo = RespostaDaOutboxSchema.parse({
      success: true,
      versao: VERSAO_DO_CONTRATO_DA_OUTBOX,
      eventos: await deps.listar(scope),
    });
    return NextResponse.json(corpo);
  };
}

/** Decisão humana sobre um efeito desconhecido: reconciliar ou autorizar replay. */
export function criarDecisaoDaOutbox(deps: DependenciasDaOutbox) {
  return async function decidir(request: Request, eventoIdBruto: string) {
    const contexto = await deps.resolverContexto(request);
    if (contexto._tag !== 'OrganizationContextResolved') return negado(contexto);
    // A capability é conferida aqui e de novo no banco (papel owner/admin).
    if (!contexto.context.capabilities.has('organization:manage')) {
      return NextResponse.json({ success: false, error: MENSAGEM_DA_FALHA.SemPapel }, { status: 403 });
    }
    const eventoId = z.string().uuid().safeParse(eventoIdBruto);
    const pedido = DecisaoDaOutboxSchema.safeParse(await request.json().catch(() => null));
    if (!eventoId.success || !pedido.success) {
      return NextResponse.json({ success: false, error: MENSAGEM_DA_FALHA.EntradaInvalida }, { status: 400 });
    }
    const scope = organizationContextToScope(contexto.context);
    const decisao = pedido.data.acao === 'replay'
      ? await deps.autorizarReplay(scope, eventoId.data)
      : await deps.resolver(scope, eventoId.data, {
        resolucao: pedido.data.resolucao,
        reciboRef: 'reciboRef' in pedido.data ? pedido.data.reciboRef : undefined,
        evidencia: pedido.data.evidencia,
      });

    const acaoDeAuditoria = pedido.data.acao === 'replay'
      ? (decisao._tag === 'DecisaoAplicada' ? 'outbox.replay_authorized' : 'outbox.replay_refused')
      : (decisao._tag === 'DecisaoAplicada' ? 'outbox.effect_reconciled' : null);
    if (acaoDeAuditoria) {
      await deps.auditar(scope, acaoDeAuditoria, eventoId.data, decisao._tag === 'DecisaoAplicada'
        ? { acao: pedido.data.acao, status: decisao.status, ...(pedido.data.acao === 'reconciliar' ? { resolucao: pedido.data.resolucao } : {}) }
        : { acao: pedido.data.acao, falha: decisao.falha });
    }

    if (decisao._tag === 'DecisaoRecusada') {
      return NextResponse.json(
        { success: false, falha: decisao.falha, error: MENSAGEM_DA_FALHA[decisao.falha] },
        { status: STATUS_DA_FALHA[decisao.falha] },
      );
    }
    return NextResponse.json({ success: true, status: decisao.status });
  };
}
