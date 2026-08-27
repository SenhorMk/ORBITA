import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabaseServer';
import { credentialsVault, redactSensitiveData } from '@/lib/integrations/credentialsVault';
import { resolveActiveRequestOrganizationContext } from '@/lib/requestOrganizationContext';
import { organizationContextStatus } from '@/lib/organizationAuthorization';
import { organizationContextToScope } from '@/lib/verifiedOrganizationScope';
import { ChatwootCredentialsPayloadSchema } from '@/services/chatwoot/chatwootPort';

export const dynamic = 'force-dynamic';

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

    const { data: existing, error: findError } = await supabaseServer
      .from('conexoes_integracao')
      .select('id')
      .eq('organizacao_id', scope.organizationId)
      .eq('provedor', 'chatwoot')
      .maybeSingle();
    if (findError) throw findError;

    let conexaoId: string;
    if (existing?.id) {
      conexaoId = existing.id;
      const { error: updateError } = await supabaseServer
        .from('conexoes_integracao')
        .update({ status: 'conectado', updated_at: new Date().toISOString() })
        .eq('id', conexaoId)
        .eq('organizacao_id', scope.organizationId);
      if (updateError) throw updateError;
    } else {
      const { data: inserted, error: insertError } = await supabaseServer
        .from('conexoes_integracao')
        .insert({ organizacao_id: scope.organizationId, provedor: 'chatwoot', nome: 'Principal', status: 'conectado' })
        .select('id')
        .single();
      if (insertError || !inserted) throw insertError || new Error('Falha ao criar conexão Chatwoot');
      conexaoId = inserted.id;
    }

    await credentialsVault.saveEncryptedCredentials(scope.organizationId, conexaoId, parsed.data);

    return NextResponse.json({
      success: true,
      conexaoId,
      webhookUrl: `/api/chatwoot/webhook/${conexaoId}`,
    });
  } catch (error: unknown) {
    console.error('❌ Erro ao conectar Chatwoot:', redactSensitiveData(error instanceof Error ? { message: error.message } : error));
    const message = error instanceof Error ? error.message : 'Erro ao conectar Chatwoot';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
