import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabaseServer';
import { credentialsVault, redactSensitiveData } from '@/lib/integrations/credentialsVault';
import { resolveActiveRequestOrganizationContext } from '@/lib/requestOrganizationContext';
import { organizationContextStatus } from '@/lib/organizationAuthorization';
import { organizationContextToScope, type VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import { organizacaoEsperadaDivergente, ORGANIZACAO_ESPERADA_DIVERGENTE } from '@/lib/integrations/organizacaoEsperada';
import {
  blingCredentialsPayloadSchema,
  buildBlingVaultCredentials,
  type BlingCredentialsPayload,
} from '@/lib/config/blingCredentialsContract';

export const dynamic = 'force-dynamic';

/** Nome canônico da conexão Bling de uma organização, casado com `uq_conexoes_integracao_org_provedor_nome`. */
const BLING_CONNECTION_NAME = 'Principal';

/** Escopo verificado ou a resposta HTTP que nega a requisição. */
type AuthorizationOutcome =
  | { readonly _tag: 'Authorized'; readonly scope: VerifiedOrganizationScope }
  | { readonly _tag: 'Denied'; readonly response: NextResponse };

/**
 * Deriva a organização da sessão verificada e exige `organization:manage`.
 *
 * Conectar uma integração é uma capacidade privilegiada, distinta de usá-la —
 * o mesmo contrato de `POST /api/chatwoot/connect`. Nenhum identificador de
 * organização vindo do corpo é considerado.
 */
async function authorizeBlingConnect(request: Request): Promise<AuthorizationOutcome> {
  const contextResult = await resolveActiveRequestOrganizationContext(request);
  if (contextResult._tag !== 'OrganizationContextResolved') {
    const status = organizationContextStatus(contextResult);
    return {
      _tag: 'Denied',
      response: NextResponse.json(
        { success: false, error: status === 503 ? 'Serviço de autorização indisponível' : 'Não autorizado' },
        { status },
      ),
    };
  }

  if (!contextResult.context.capabilities.has('organization:manage')) {
    return {
      _tag: 'Denied',
      response: NextResponse.json(
        { success: false, error: 'Capacidade insuficiente para gerenciar integrações' },
        { status: 403 },
      ),
    };
  }

  return { _tag: 'Authorized', scope: organizationContextToScope(contextResult.context) };
}

/**
 * Cria ou atualiza a conexão Bling da organização, idempotente por
 * `(organizacao_id, provedor)`.
 *
 * O `client_id` vai para `metadata` porque `GET /api/bling/authorize` o lê de
 * lá.
 *
 * **Gravar credenciais novas derruba a conexão anterior.** A versão anterior
 * preservava o `status` — a intenção era boa (só o callback OAuth declara
 * `conectado`), mas o efeito era o oposto: os tokens guardados no cofre foram
 * emitidos para o Client ID *antigo* e deixam de valer no instante em que
 * outro par de chaves é gravado, enquanto a linha continuava dizendo
 * `conectado`. A tela então afirmava uma autorização que já não existia, sem
 * nenhuma evidência.
 *
 * Junto do `status`, a evidência de saúde também é apagada: `last_health_*`
 * descreve uma checagem feita contra as chaves anteriores, e mantê-la seria a
 * mesma mentira num campo diferente. Sem `last_health_check_at`, a tela diz
 * "não verificado" — que é a verdade.
 */
async function upsertBlingConnection(
  scope: VerifiedOrganizationScope,
  clientId: string,
): Promise<{ conexaoId: string; status: string }> {
  const { data: existing, error: findError } = await supabaseServer
    .from('conexoes_integracao')
    .select('id, metadata, status')
    .eq('organizacao_id', scope.organizationId)
    .eq('provedor', 'bling')
    .maybeSingle();
  if (findError) throw findError;

  // SAFETY: `metadata` é `jsonb not null default '{}'` no schema; o narrowing
  // rejeita qualquer outra forma antes de espalhar as chaves existentes.
  const currentMetadata =
    typeof existing?.metadata === 'object' && existing.metadata !== null && !Array.isArray(existing.metadata)
      ? (existing.metadata as Record<string, unknown>)
      : {};
  const metadata = { ...currentMetadata, client_id: clientId };

  if (existing?.id) {
    const { error: updateError } = await supabaseServer
      .from('conexoes_integracao')
      .update({
        metadata,
        status: 'pendente',
        last_health_check_at: null,
        last_health_error: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', existing.id)
      .eq('organizacao_id', scope.organizationId);
    if (updateError) throw updateError;
    return { conexaoId: existing.id, status: 'pendente' };
  }

  const { data: inserted, error: insertError } = await supabaseServer
    .from('conexoes_integracao')
    .insert({
      organizacao_id: scope.organizationId,
      provedor: 'bling',
      nome: BLING_CONNECTION_NAME,
      status: 'pendente',
      metadata,
    })
    .select('id')
    .single();
  if (insertError || !inserted) throw insertError || new Error('Falha ao criar conexão Bling');
  return { conexaoId: inserted.id, status: 'pendente' };
}

/** Lê e valida o corpo com o contrato compartilhado com a UI, ou devolve a recusa 400. */
async function parseBlingCredentialsBody(
  request: Request,
): Promise<{ _tag: 'Parsed'; payload: BlingCredentialsPayload } | { _tag: 'Invalid'; response: NextResponse }> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return {
      _tag: 'Invalid',
      response: NextResponse.json({ success: false, error: 'Corpo da requisição inválido' }, { status: 400 }),
    };
  }

  const parsed = blingCredentialsPayloadSchema.safeParse(body);
  if (!parsed.success) {
    return {
      _tag: 'Invalid',
      response: NextResponse.json(
        {
          success: false,
          error: 'Client ID e Client Secret do Bling são obrigatórios.',
          details: parsed.error.issues.map((issue) => issue.message),
        },
        { status: 400 },
      ),
    };
  }

  return { _tag: 'Parsed', payload: parsed.data };
}

/**
 * Registra ou atualiza as credenciais do aplicativo Bling de uma organização.
 *
 * Espelha `POST /api/chatwoot/connect` (Ticket 11): mesma autorização por
 * capacidade, mesma persistência em `conexoes_integracao` + cofre cifrado
 * `credenciais_integracao`. O `client_secret` só existe cifrado no cofre e
 * nunca volta em resposta nem em log.
 */
export async function POST(request: Request) {
  try {
    const authorization = await authorizeBlingConnect(request);
    if (authorization._tag === 'Denied') return authorization.response;

    const parsedBody = await parseBlingCredentialsBody(request);
    if (parsedBody._tag === 'Invalid') return parsedBody.response;

    if (organizacaoEsperadaDivergente(parsedBody.payload.organizacaoEsperada, authorization.scope.organizationId)) {
      return NextResponse.json({ success: false, error: ORGANIZACAO_ESPERADA_DIVERGENTE }, { status: 409 });
    }

    const { conexaoId, status } = await upsertBlingConnection(authorization.scope, parsedBody.payload.clientId);

    await credentialsVault.saveEncryptedCredentials(
      authorization.scope.organizationId,
      conexaoId,
      buildBlingVaultCredentials(parsedBody.payload),
    );

    return NextResponse.json({ success: true, conexaoId, status });
  } catch (error: unknown) {
    console.error(
      '❌ Erro ao conectar Bling:',
      redactSensitiveData(error instanceof Error ? { message: error.message } : error),
    );
    return NextResponse.json({ success: false, error: 'Erro ao salvar credenciais do Bling' }, { status: 500 });
  }
}
