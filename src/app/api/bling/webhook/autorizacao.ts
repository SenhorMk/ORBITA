import { NextResponse } from 'next/server';

import { supabaseServer } from '../../../../lib/supabaseServer';
import { verifyOrganizationScope, type VerifiedOrganizationScope } from '../../../../lib/verifiedOrganizationScope';
import { bling } from '../../../../services/bling';
import type { BlingPort } from '../../../../services/blingPort';

import { createSupabaseBlingWebhookTenantStore, resolveSignedBlingConnection } from './tenants';

/**
 * Autorização do webhook do Bling: quem assinou, e em nome de qual organização.
 *
 * Separado de `route.ts` para manter o arquivo dentro do limite do portão de
 * qualidade e porque é uma responsabilidade distinta do processamento dos
 * eventos — quem autoriza não precisa saber o que o evento faz.
 */
/** Resultado da resolução de tenant/organização a partir da assinatura HMAC do webhook. */
type WebhookAuthorizationResult =
  | { readonly _tag: 'Authorized'; readonly organizationScope: VerifiedOrganizationScope; readonly conexaoId: string | null; readonly blingClient: BlingPort }
  | { readonly _tag: 'Denied'; readonly response: NextResponse };

/**
 * Valida a assinatura HMAC do evento contra o secret de cada conexão Bling
 * guardado no cofre e resolve a organização dona da conexão que assinou.
 *
 * A organização vem da própria linha de `conexoes_integracao` — não há mais
 * resolução por `user_id` legado (`metadata->>'migrado_de_user_id'`), por
 * varredura de `membros_organizacao`, nem ramo de ambiguidade: uma conexão
 * pertence a exatamente uma organização, por construção. Ver `tenants.ts`
 * para por que a leitura tinha de sair de `integracoes_bling`.
 *
 * O evento não tem ator humano. O escopo é verificado contra o **dono** da
 * organização, que é uma linha de membership real, e não um ator inventado.
 * Um `VerifiedOrganizationScope` sem ator exigiria tornar `actorId` opcional
 * em todos os repositórios; ficou registrado como dívida no ticket 11 em vez
 * de ser feito de passagem aqui.
 */
export async function authorizeWebhookTenant(
  rawBody: string,
  signatureHeader: string | null,
): Promise<WebhookAuthorizationResult> {
  if (!signatureHeader) {
    console.warn('⚠️ Webhook Bling: Assinatura ausente. Payload ignorado.');
    return { _tag: 'Denied', response: NextResponse.json({ success: false, error: 'Assinatura ausente' }, { status: 403 }) };
  }

  const store = createSupabaseBlingWebhookTenantStore(supabaseServer);
  const connectionResult = await resolveSignedBlingConnection(store, rawBody, signatureHeader);

  if (connectionResult._tag === 'ConnectionStoreUnavailable') {
    // 503, e não 403. A documentação do Bling prevê nova tentativa para
    // qualquer resposta diferente de 2xx, então o que está em jogo não é "ele
    // reentrega ou não", e sim dizer a verdade: o problema é nosso, não da
    // assinatura. Responder "assinatura inválida" para uma falha de banco
    // manda a investigação para o lado errado.
    console.error('❌ Webhook Bling: conexões indisponíveis:', connectionResult.cause);
    return {
      _tag: 'Denied',
      response: NextResponse.json({ success: false, error: 'Serviço de conexões indisponível' }, { status: 503 }),
    };
  }

  if (connectionResult._tag === 'SignatureUnconfirmable') {
    // Nenhuma conexão casou, mas pelo menos uma não pôde ser conferida porque o
    // cofre não respondeu. Não sabemos se a assinatura é válida — e um 403 aqui
    // afirmaria que ela é falsa.
    console.error(
      `❌ Webhook Bling: assinatura não pôde ser conferida em ${connectionResult.conexoesAfetadas.length} conexão(ões):`,
      connectionResult.cause,
    );
    return {
      _tag: 'Denied',
      response: NextResponse.json(
        { success: false, error: 'Não foi possível confirmar a assinatura do evento.' },
        { status: 503 },
      ),
    };
  }

  if (connectionResult._tag !== 'ConnectionResolved') {
    console.warn('⚠️ Webhook Bling: Assinatura inválida (nenhuma conexão correspondente). Payload ignorado.');
    return { _tag: 'Denied', response: NextResponse.json({ success: false, error: 'Assinatura inválida' }, { status: 403 }) };
  }

  const { id: conexaoId, organizacaoId } = connectionResult.connection;

  const { data: owner, error: ownerError } = await supabaseServer
    .from('membros_organizacao')
    .select('user_id')
    .eq('organizacao_id', organizacaoId)
    .eq('papel', 'owner')
    .limit(1)
    .maybeSingle();

  if (ownerError) {
    console.error('❌ Webhook Bling: falha ao resolver o dono da organização:', ownerError.message);
    return {
      _tag: 'Denied',
      response: NextResponse.json({ success: false, error: 'Serviço de autorização indisponível' }, { status: 503 }),
    };
  }

  const actorId = typeof owner?.user_id === 'string' ? owner.user_id : null;
  if (!actorId) {
    console.warn(`⚠️ Webhook Bling: organização ${organizacaoId} não tem dono; evento recusado.`);
    return {
      _tag: 'Denied',
      response: NextResponse.json({ success: false, error: 'Organização sem dono para atribuir o evento.' }, { status: 403 }),
    };
  }

  const blingClient = bling.forOrganization(organizacaoId, conexaoId);
  const scopeResult = await verifyOrganizationScope(supabaseServer, { organizationId: organizacaoId, actorId });
  if (scopeResult._tag !== 'OrganizationScopeVerified') {
    const unavailable = scopeResult._tag === 'OrganizationScopeStoreUnavailable';
    return {
      _tag: 'Denied',
      response: NextResponse.json(
        { success: false, error: unavailable ? 'Serviço de autorização indisponível' : 'Escopo organizacional inválido' },
        { status: unavailable ? 503 : 403 },
      ),
    };
  }

  return { _tag: 'Authorized', organizationScope: scopeResult.scope, conexaoId, blingClient };
}
