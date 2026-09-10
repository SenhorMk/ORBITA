import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabaseServer';
import { credentialsVault, redactSensitiveData } from '@/lib/integrations/credentialsVault';
import { resolveActiveRequestOrganizationContext } from '@/lib/requestOrganizationContext';
import { organizationContextStatus } from '@/lib/organizationAuthorization';
import { organizationContextToScope } from '@/lib/verifiedOrganizationScope';
import { ChatwootCredentialsPayloadSchema } from '@/services/chatwoot/chatwootPort';
import { resolveChatwootWebhookUrl, chatwootWebhookPath } from '@/lib/config/appBaseUrl';
import { organizacaoEsperadaDivergente, ORGANIZACAO_ESPERADA_DIVERGENTE } from '@/lib/integrations/organizacaoEsperada';

export const dynamic = 'force-dynamic';

/**
 * Cria ou atualiza a conexão Chatwoot da organização, e devolve o seu id.
 *
 * **Gravar credenciais não é prova de que a instância responde.** A versão
 * anterior marcava `conectado` no próprio salvamento, e a tela pintava de
 * verde uma URL que podia estar errada, um token revogado ou uma conta
 * inexistente. `pendente` é o que de fato se sabe: há configuração, não há
 * verificação. A evidência de saúde anterior cai junto, porque ela descreve
 * uma checagem feita com as credenciais que acabaram de ser substituídas.
 */
async function upsertChatwootConnection(organizacaoId: string, conexaoExistenteId: string | null): Promise<string> {
  if (conexaoExistenteId) {
    const { error: updateError } = await supabaseServer
      .from('conexoes_integracao')
      .update({
        status: 'pendente',
        last_health_check_at: null,
        last_health_error: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', conexaoExistenteId)
      .eq('organizacao_id', organizacaoId);
    if (updateError) throw updateError;
    return conexaoExistenteId;
  }

  const { data: inserted, error: insertError } = await supabaseServer
    .from('conexoes_integracao')
    .insert({ organizacao_id: organizacaoId, provedor: 'chatwoot', nome: 'Principal', status: 'pendente' })
    .select('id')
    .single();
  if (insertError || !inserted) throw insertError || new Error('Falha ao criar conexão Chatwoot');
  return inserted.id;
}

/**
 * Create or update the organization's Chatwoot connection: persists the
 * connection row and encrypts the private credentials (API token, account id,
 * per-connection webhook secret) in the credentials vault. Requires
 * `organization:manage` — connecting an integration is a privileged
 * capability, distinct from using it (`send`/`status`/`sync`).
 */
export async function POST(request: Request) {
  try {
    const contextResult = await resolveActiveRequestOrganizationContext(request);
    if (contextResult._tag !== 'OrganizationContextResolved') {
      const status = organizationContextStatus(contextResult);
      return NextResponse.json(
        { success: false, error: status === 503 ? 'Serviço de autorização indisponível' : 'Não autorizado' },
        { status },
      );
    }

    if (!contextResult.context.capabilities.has('organization:manage')) {
      return NextResponse.json({ success: false, error: 'Capacidade insuficiente para gerenciar integrações' }, { status: 403 });
    }

    const scope = organizationContextToScope(contextResult.context);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ success: false, error: 'Corpo da requisição inválido' }, { status: 400 });
    }

    const parsed = ChatwootCredentialsPayloadSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: 'Credenciais Chatwoot inválidas: api_token, account_id e webhook_secret são obrigatórios' },
        { status: 400 },
      );
    }

    // Mesma guarda de `POST /api/bling/connect`: se a organização ativa mudou
    // desde que o formulário foi enviado, nada é gravado em lugar nenhum.
    const esperada = (body as { organizacao_esperada?: unknown }).organizacao_esperada;
    if (organizacaoEsperadaDivergente(typeof esperada === 'string' ? esperada : null, scope.organizationId)) {
      return NextResponse.json({ success: false, error: ORGANIZACAO_ESPERADA_DIVERGENTE }, { status: 409 });
    }

    const { data: existing, error: findError } = await supabaseServer
      .from('conexoes_integracao')
      .select('id')
      .eq('organizacao_id', scope.organizationId)
      .eq('provedor', 'chatwoot')
      .maybeSingle();
    if (findError) throw findError;
    const conexaoId = await upsertChatwootConnection(scope.organizationId, existing?.id ?? null);

    await credentialsVault.saveEncryptedCredentials(scope.organizationId, conexaoId, parsed.data);

    return NextResponse.json({
      success: true,
      conexaoId,
      // Absoluta quando a origem estavel esta configurada: o endereco e colado
      // dentro do Chatwoot, e um caminho relativo nao serve la.
      webhookUrl: resolveChatwootWebhookUrl(
        { APP_BASE_URL: process.env.APP_BASE_URL, STRIPE_APP_BASE_URL: process.env.STRIPE_APP_BASE_URL },
        conexaoId,
      ) ?? chatwootWebhookPath(conexaoId),
    });
  } catch (error: unknown) {
    console.error('❌ Erro ao conectar Chatwoot:', redactSensitiveData(error instanceof Error ? { message: error.message } : error));
    const message = error instanceof Error ? error.message : 'Erro ao conectar Chatwoot';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
