import { NextResponse } from 'next/server';
import { z } from 'zod';

import {
  RespostaDaVerificacaoSchema,
  RespostaDosPedidosSchema,
  VERSAO_DO_CONTRATO_DA_VERIFICACAO,
} from '@/lib/integrations/contratoDaVerificacao';
import { getCorrelationId } from '@/lib/observability/correlation';
import { logger } from '@/lib/observability/logger';
import { organizationContextStatus, type OrganizationContextResult } from '@/lib/organizationAuthorization';
import { organizationContextToScope, type VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import {
  VerificacaoIndisponivel,
  type ConsultaDePedidos,
  type LeituraDaVerificacao,
  type ResultadoDaConfirmacao,
  type ResultadoDaConsulta,
  type ResultadoDaRevogacao,
} from '@/services/sac/clienteVerificado';

/** As fronteiras que as rotas usam; produção liga o Supabase, o teste liga fakes. */
export interface DependenciasDaVerificacao {
  readonly resolverContexto: (request: Request) => Promise<OrganizationContextResult>;
  readonly ler: (scope: VerifiedOrganizationScope, conversaId: string) => Promise<LeituraDaVerificacao>;
  readonly confirmar: (
    scope: VerifiedOrganizationScope,
    comando: { readonly conversaId: string; readonly commandId: string; readonly clienteId: string },
  ) => Promise<ResultadoDaConfirmacao>;
  readonly revogar: (scope: VerifiedOrganizationScope, conversaId: string) => Promise<ResultadoDaRevogacao>;
  readonly consultaDePedidos: (scope: VerifiedOrganizationScope, conversaId: string) => ConsultaDePedidos;
}

/**
 * Confirmar quem é a pessoa e consultar os pedidos dela é parte de atender:
 * vale para quem acessa a organização, como responder (MSG-008). Uma
 * capacidade própria de atendimento é decisão de produto pendente.
 */
const CAPACIDADE_DE_ATENDER = 'organization:access' as const;

const ConversaSchema = z.object({ conversaId: z.string().uuid() });
const AlteracaoSchema = z.discriminatedUnion('acao', [
  z.object({ acao: z.literal('confirmar'), conversaId: z.string().uuid(), commandId: z.string().uuid(), clienteId: z.string().uuid() }),
  z.object({ acao: z.literal('revogar'), conversaId: z.string().uuid() }),
]);
const LocalizacaoSchema = z.object({ conversaId: z.string().uuid(), numero: z.string().trim().min(1).max(40) });

function recusar(error: string, status: number, motivo?: string) {
  return NextResponse.json({ success: false, error, ...(motivo ? { motivo } : {}) }, { status });
}

const indisponivel = () => recusar('Verificação do cliente indisponível. Nada foi alterado nem consultado.', 503);

type Sessao =
  | { readonly _tag: 'Recusado'; readonly resposta: NextResponse }
  | { readonly _tag: 'Autorizado'; readonly scope: VerifiedOrganizationScope };

/** Recusas da consulta: o que a rota responde e o que o log registra. Nunca o número tentado. */
const RECUSA_DA_CONSULTA = {
  SemProva: ['Confirme o cliente da conversa antes de consultar pedidos.', 409, 'sem_prova'],
  Bloqueada: ['Muitas tentativas sem resultado. A consulta por número volta em alguns minutos.', 429, 'bloqueada'],
  NaoEncontrado: ['Nenhum pedido deste cliente com esse número.', 404, 'nao_encontrado'],
  ConversaNaoEncontrada: ['Conversa não encontrada', 404, 'conversa_nao_encontrada'],
} as const;

const RECUSA_DA_CONFIRMACAO = {
  ClienteNaoEncontrado: ['Cliente não encontrado', 404, 'cliente_nao_encontrado'],
  ConversaNaoEncontrada: ['Conversa não encontrada', 404, 'conversa_nao_encontrada'],
  ConflitoDeComando: ['Este comando já foi usado com outros dados.', 409, 'conflito_comando'],
  SemVinculo: ['Não autorizado', 403, 'sem_vinculo'],
} as const;

/** Verificação do cliente e consulta de pedidos da conversa, só da organização da sessão. */
export function criarRotasDaVerificacao(deps: DependenciasDaVerificacao) {
  async function sessaoDe(request: Request): Promise<Sessao> {
    const contexto = await deps.resolverContexto(request);
    if (contexto._tag !== 'OrganizationContextResolved') {
      const status = organizationContextStatus(contexto);
      return { _tag: 'Recusado', resposta: recusar(status === 503 ? 'Serviço de autorização indisponível' : 'Não autorizado', status) };
    }
    if (!contexto.context.capabilities.has(CAPACIDADE_DE_ATENDER)) {
      return { _tag: 'Recusado', resposta: recusar('Sem permissão para atender nesta organização.', 403) };
    }
    return { _tag: 'Autorizado', scope: organizationContextToScope(contexto.context) };
  }

  /** Um evento por comando ou recusa: quem, em qual conversa, com qual desfecho. Sem cliente, documento ou número. */
  function registrar(request: Request, scope: VerifiedOrganizationScope, evento: string, campos: Record<string, unknown>, recusa: boolean) {
    const contexto = { correlationId: getCorrelationId(request), organizacaoId: scope.organizationId, actorId: scope.actorId, ...campos };
    if (recusa) logger.warn(evento, contexto);
    else logger.info(evento, contexto);
  }

  function responderConsulta(request: Request, scope: VerifiedOrganizationScope, conversaId: string, consulta: ResultadoDaConsulta) {
    if (consulta._tag === 'Pedidos') {
      return NextResponse.json(RespostaDosPedidosSchema.parse({
        success: true, versao: VERSAO_DO_CONTRATO_DA_VERIFICACAO, pedidos: consulta.pedidos,
      }));
    }
    const [mensagem, status, motivo] = RECUSA_DA_CONSULTA[consulta._tag];
    registrar(request, scope, 'sac.consulta_de_pedido', { conversaId, outcome: motivo }, true);
    return recusar(mensagem, status, motivo);
  }

  /** Só `VerificacaoIndisponivel` vira 503; qualquer outra falha sobe para o tratamento da rota. */
  async function protegido(acao: () => Promise<NextResponse>) {
    try {
      return await acao();
    } catch (erro: unknown) {
      if (erro instanceof VerificacaoIndisponivel) return indisponivel();
      throw erro;
    }
  }

  return {
    async lerVerificacao(request: Request) {
      const sessao = await sessaoDe(request);
      if (sessao._tag === 'Recusado') return sessao.resposta;
      const parsed = ConversaSchema.safeParse({ conversaId: new URL(request.url).searchParams.get('conversaId') });
      if (!parsed.success) return recusar('Parâmetro conversaId (UUID) é obrigatório.', 400);

      return protegido(async () => {
        const leitura = await deps.ler(sessao.scope, parsed.data.conversaId);
        if (leitura._tag === 'ConversaNaoEncontrada') return recusar('Conversa não encontrada', 404, 'conversa_nao_encontrada');
        return NextResponse.json(RespostaDaVerificacaoSchema.parse({
          success: true, versao: VERSAO_DO_CONTRATO_DA_VERIFICACAO, verificacao: leitura.verificacao, candidatos: leitura.candidatos,
        }));
      });
    },

    async alterarVerificacao(request: Request) {
      const sessao = await sessaoDe(request);
      if (sessao._tag === 'Recusado') return sessao.resposta;
      const parsed = AlteracaoSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return recusar('Informe acao (confirmar ou revogar) e conversaId; confirmar exige commandId e clienteId (UUID).', 400);
      const corpo = parsed.data;
      const { scope } = sessao;

      return protegido(async () => {
        if (corpo.acao === 'revogar') {
          const revogacao = await deps.revogar(scope, corpo.conversaId);
          if (revogacao._tag === 'ConversaNaoEncontrada') return recusar('Conversa não encontrada', 404, 'conversa_nao_encontrada');
          if (revogacao._tag === 'SemVinculo') return recusar('Não autorizado', 403, 'sem_vinculo');
          const revogada = revogacao._tag === 'Revogada';
          registrar(request, scope, 'sac.verificacao', { acao: 'revogar', conversaId: corpo.conversaId, outcome: revogada ? 'revogada' : 'sem_prova' }, false);
          return NextResponse.json({ success: true, revogada });
        }

        const resultado = await deps.confirmar(scope, { conversaId: corpo.conversaId, commandId: corpo.commandId, clienteId: corpo.clienteId });
        if (resultado._tag === 'Confirmado') {
          registrar(request, scope, 'sac.verificacao', {
            acao: 'confirmar', conversaId: corpo.conversaId, outcome: resultado.duplicado ? 'existente' : 'confirmado', vinculoId: resultado.vinculoId,
          }, false);
          return NextResponse.json({ success: true, duplicado: resultado.duplicado, expiraEm: resultado.expiraEm });
        }
        const [mensagem, status, motivo] = RECUSA_DA_CONFIRMACAO[resultado._tag];
        registrar(request, scope, 'sac.verificacao', { acao: 'confirmar', conversaId: corpo.conversaId, outcome: motivo }, true);
        return recusar(mensagem, status, motivo);
      });
    },

    async listarPedidos(request: Request) {
      const sessao = await sessaoDe(request);
      if (sessao._tag === 'Recusado') return sessao.resposta;
      const parsed = ConversaSchema.safeParse({ conversaId: new URL(request.url).searchParams.get('conversaId') });
      if (!parsed.success) return recusar('Parâmetro conversaId (UUID) é obrigatório.', 400);
      const { conversaId } = parsed.data;

      return protegido(async () =>
        responderConsulta(request, sessao.scope, conversaId, await deps.consultaDePedidos(sessao.scope, conversaId).listar()));
    },

    /** POST para o número ir no corpo: ele não fica em URL nem em log de acesso. */
    async localizarPedido(request: Request) {
      const sessao = await sessaoDe(request);
      if (sessao._tag === 'Recusado') return sessao.resposta;
      const parsed = LocalizacaoSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return recusar('Informe conversaId (UUID) e numero (1 a 40 caracteres).', 400);
      const { conversaId, numero } = parsed.data;

      return protegido(async () =>
        responderConsulta(request, sessao.scope, conversaId, await deps.consultaDePedidos(sessao.scope, conversaId).localizar(numero)));
    },
  };
}
