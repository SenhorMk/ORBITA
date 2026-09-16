import { NextResponse } from 'next/server';
import { resolveAuthenticatedIdentity } from '@/lib/auth';
import { readBearerToken } from '@/lib/bearer-token';
import { createActorScopedSupabaseClient } from '@/lib/supabaseActorClient';
import { logger } from '@/lib/observability/logger';
import { registrarFalhaInterna } from '@/lib/observability/falhaInterna';
import { ACTIVE_ORG_COOKIE_NAME } from '@/lib/organizationContext';
import {
  parseOrganizationActorId,
  parseOrganizationId,
  type OrganizationActorId,
  type OrganizationId,
  type OrganizationSwitchResult,
} from '@/lib/organizationAuthorization';
import {
  acceptInviteInputSchema,
  acceptOrgInvite,
} from '@/lib/invitationService';

/** As duas fronteiras que o aceite precisa depois de a RPC ter aceitado o convite. */
export interface AcceptInviteDependencies {
  /**
   * Seleciona a organização ingressada como ativa **pelo CAS**, com versão
   * esperada `0`.
   *
   * A versão `0` é a pergunta inteira: `alternar_organizacao_ativa_cas`
   * (migration 38) insere com `on conflict (user_id) do nothing`, então ela
   * aplica exatamente quando não existe seleção nenhuma, e devolve
   * `OrganizationSwitchStale` quando já existe uma. É assim que a seleção
   * válida de quem já estava em outra organização é preservada sem que a rota
   * precise ler o estado e decidir por conta própria — decidir fora do CAS
   * seria uma corrida.
   */
  readonly selecionarSeNaoHouverSelecao: (
    actorId: OrganizationActorId,
    organizationId: OrganizationId,
  ) => Promise<OrganizationSwitchResult>;

  /** Espelha no cookie a seleção que o servidor **de fato** aplicou. */
  readonly gravarCookieDeOrganizacaoAtiva: (organizacaoId: string) => Promise<void>;
}

/**
 * A **segunda** etapa do aceite, depois de a primeira já ter commitado.
 *
 * Ela vive numa função própria porque a distinção que faz é fácil de perder de
 * vista no meio do handler: `Stale` é o servidor funcionando, enquanto `Denied`
 * e `MembershipStoreUnavailable` são a etapa não tendo terminado.
 *
 * @param dependencies - Seleção canônica e espelho em cookie.
 * @param contexto - O par verificado, o id devolvido pela RPC e o ator, para o log.
 * @returns A resposta HTTP do aceite.
 */
async function resolverContextoAposAceite(
  dependencies: AcceptInviteDependencies,
  contexto: {
    readonly actorId: OrganizationActorId;
    readonly organizationId: OrganizationId;
    readonly organizacaoId: string;
    readonly atorId: string;
  },
) {
  const { organizacaoId } = contexto;
  const selecao = await dependencies.selecionarSeNaoHouverSelecao(contexto.actorId, contexto.organizationId);

  if (selecao._tag === 'OrganizationSwitchApplied') {
    // Não havia seleção, e a organização ingressada passou a ser a ativa. O
    // cookie espelha o que o CAS de fato aplicou, e só isso.
    await dependencies.gravarCookieDeOrganizacaoAtiva(organizacaoId);
    return NextResponse.json({ success: true, organizacaoId, contexto: 'organizacao_ativada' });
  }

  if (selecao._tag === 'OrganizationSwitchStale') {
    // O CAS recusou porque já existia seleção — que é o resultado correto e
    // esperado. Nada é forçado por cima dela, e nenhum cookie novo é escrito:
    // o convite foi aceito e a organização anterior continua ativa.
    return NextResponse.json({ success: true, organizacaoId, contexto: 'selecao_anterior_preservada' });
  }

  // `OrganizationSwitchDenied` e `MembershipStoreUnavailable` não são isso.
  //
  // **O convite já foi consumido.** `aceitar_convite_organizacao` commitou
  // antes desta linha: a membership existe, o token está gasto e não volta.
  // Responder como se tudo tivesse terminado normalmente mandaria a pessoa
  // procurar a organização nova onde ela não aparece; responder erro seco
  // mandaria tentar o token de novo, e a segunda tentativa falharia com
  // "convite já utilizado" — um beco sem saída construído por nós.
  //
  // Então a resposta diz as duas metades: a primeira terminou, a segunda não.
  // `success` continua `true` porque a entrada na organização é real; o
  // `contexto` é que carrega a falha, e o cliente reconcilia relendo o contexto
  // canônico — não repetindo o convite. Nenhum cookie é gravado: um cookie
  // apontando para uma seleção que o servidor não aplicou seria uma segunda
  // fonte de organização ativa, divergente da canônica.
  registrarFalhaInterna(
    'convites.aceitar.contexto',
    new Error(`Selecao pos-aceite nao resolvida: ${selecao._tag}`),
    { atorId: contexto.atorId, organizacaoId },
  );
  return NextResponse.json({
    success: true,
    organizacaoId,
    contexto: 'nao_resolvido',
    aviso: 'Convite aceito, mas não foi possível atualizar a organização ativa. '
      + 'Recarregue as suas organizações — não use o código de novo.',
  });
}

/**
 * Build the invite-acceptance handler around the request-scoped seams.
 *
 * Only the persistence seams are injected: session verification, actor-scoped
 * client construction and the RPC itself stay inside the handler so that tests
 * exercise the real caller identity instead of a stand-in for it.
 *
 * ## O cookie não é prova de troca
 *
 * Quem responde "qual é a organização ativa" é `contextos_organizacao_ativos`,
 * pelo CAS — `activeOrganizationSelection()` nem lê o cookie `orbita_active_org`.
 * Um cookie apontando para B enquanto o servidor mantém A seria uma segunda
 * fonte de organização ativa, divergente da canônica.
 *
 * Por isso a seleção passa pelo CAS, o cookie só é escrito quando o CAS aplicou,
 * e a resposta diz qual dos casos ocorreu. Nenhuma troca é forçada: quem já
 * tinha seleção válida continua onde estava, e a lista recarregada pela tela
 * mostra a organização nova entre as suas.
 *
 * ## O campo `contexto`, e por que ele tem três valores
 *
 * O aceite são **duas etapas**, e a primeira commita sozinha. Colapsar as
 * quatro saídas do CAS em um booleano juntava coisas que não são a mesma:
 * `Stale` é o servidor funcionando (havia seleção, foi preservada), enquanto
 * `Denied` e `MembershipStoreUnavailable` são a segunda etapa não tendo
 * terminado — com o convite já gasto atrás dela.
 *
 * - `organizacao_ativada` — não havia seleção; a organização ingressada é a ativa.
 * - `selecao_anterior_preservada` — havia seleção válida; ela continua valendo.
 * - `nao_resolvido` — o convite foi aceito, o contexto não pôde ser resolvido.
 *   Acompanha `aviso`, e o cliente reconcilia relendo — **nunca** repetindo o
 *   token, que já não existe.
 *
 * @param dependencies - Seleção canônica e espelho em cookie.
 * @returns The `POST /api/convites/aceitar` handler.
 */
export function createAcceptInviteHandler(dependencies: AcceptInviteDependencies) {
  return async function acceptInviteHandler(req: Request) {
    // Só identidade, deliberadamente: quem aceita um convite ainda não é membro
    // de organização nenhuma, então exigir vínculo aqui negaria exatamente o
    // caso que a rota existe para atender. A autoridade sobre o convite é o
    // token **e o e-mail confirmado do destinatário**, conferidos pela própria
    // RPC contra `auth.uid()` (migrations 63 e 64).
    const bearerResult = readBearerToken(req);
    const identity = await resolveAuthenticatedIdentity(req);
    if (identity._tag !== 'IdentityVerified' || bearerResult._tag !== 'BearerTokenFound') {
      const status = identity._tag === 'IdentityProviderUnavailable' ? 503 : 401;
      return NextResponse.json(
        { error: status === 503 ? 'Serviço de autenticação indisponível' : 'Não autorizado' },
        { status },
      );
    }

    // `aceitar_convite_organizacao` cria a membership para `auth.uid()`; com a
    // service_role key o sujeito é NULL e a RPC aborta. Por isso o cliente é
    // construído com o token do próprio ator.
    const actorClientResult = createActorScopedSupabaseClient(bearerResult.token);
    if (actorClientResult._tag !== 'ActorScopedClientCreated') {
      logger.error('convites.aceitar.actor_client_unavailable', {
        subsystem: 'app',
        variable: actorClientResult.variable,
      });
      return NextResponse.json({ error: 'Serviço de autenticação indisponível' }, { status: 503 });
    }

    try {
      const rawBody = await req.json();
      const validatedInput = acceptInviteInputSchema.safeParse(rawBody);
      if (!validatedInput.success) {
        return NextResponse.json(
          { error: 'Token inválido', details: validatedInput.error.format() },
          { status: 400 }
        );
      }

      const { organizacaoId } = await acceptOrgInvite(actorClientResult.client, validatedInput.data.token);

      const actorId = parseOrganizationActorId(identity.user.id);
      const organizationId = parseOrganizationId(organizacaoId);
      if (!actorId || !organizationId) {
        // A membership existe (a RPC commitou), mas a rota não consegue nomear
        // o par para pedir a seleção. Dizer que deu tudo certo esconderia um
        // contexto que não foi resolvido.
        registrarFalhaInterna(
          'convites.aceitar',
          new Error('Identificadores fora do contrato apos o aceite do convite'),
          { atorId: identity.user.id },
        );
        return NextResponse.json({ error: 'Não foi possível aceitar o convite' }, { status: 400 });
      }

      return resolverContextoAposAceite(dependencies, {
        actorId,
        organizationId,
        organizacaoId,
        atorId: identity.user.id,
      });
    } catch (error: unknown) {
      // A RPC recusa por várias razões — convite inexistente, expirado, já
      // aceito, e-mail de outro destinatário. A mensagem dela é texto do
      // Postgres, que carrega valor de linha em vários casos, e ainda diria a
      // quem tenta um token qualquer *por que* aquele token não serve. As duas
      // coisas são vazamento, então a resposta é uma só (CWE-209).
      //
      // Limitação conhecida: quem tinha um convite legítimo e expirado também
      // não fica sabendo que ele expirou. Informar isso sem criar um oráculo
      // exigiria classificar as recusas da RPC em erros de domínio tipados.
      registrarFalhaInterna('convites.aceitar', error, { atorId: identity.user.id });
      return NextResponse.json({ error: 'Não foi possível aceitar o convite' }, { status: 400 });
    }
  };
}

/** Production invite-acceptance route. */
export async function POST(req: Request) {
  const { cookies } = await import('next/headers');
  const { supabaseServer } = await import('@/lib/supabaseServer');
  const { SupabaseOrganizationMemberships } = await import('@/repositories/organizationMembershipRepository');
  const memberships = new SupabaseOrganizationMemberships(supabaseServer);
  const handler = createAcceptInviteHandler({
    selecionarSeNaoHouverSelecao: (actorId, organizationId) => memberships.switchActiveOrganization(
      actorId,
      organizationId,
      0,
    ),
    gravarCookieDeOrganizacaoAtiva: async (organizacaoId) => {
      (await cookies()).set(ACTIVE_ORG_COOKIE_NAME, organizacaoId, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: 60 * 60 * 24 * 30, // 30 dias
      });
    },
  });
  return handler(req);
}
