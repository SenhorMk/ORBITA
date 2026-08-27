import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ChatwootAdapter } from '../../../../services/chatwoot/chatwootAdapter';
import { supabaseServer } from '../../../../lib/supabaseServer';
import { organizationContextStatus } from '../../../../lib/organizationAuthorization';
import { resolveActiveRequestOrganizationContext } from '../../../../lib/requestOrganizationContext';
import { organizationContextToScope, type VerifiedOrganizationScope } from '../../../../lib/verifiedOrganizationScope';

export const dynamic = 'force-dynamic';
const conversationStatusSchema = z.enum(['open', 'resolved', 'pending']);

type UpdateConversationStatusResult = 'updated' | 'not-found' | 'unconfigured' | { failed: string };

async function updateConversationStatus(
  scope: VerifiedOrganizationScope,
  conversationId: number,
  status: z.infer<typeof conversationStatusSchema>,
): Promise<UpdateConversationStatusResult> {
  const { data: existingConv, error: convCheckError } = await supabaseServer
    .from('chatwoot_conversations')
    .select('id')
    .eq('id', conversationId)
    .eq('organizacao_id', scope.organizationId)
    .maybeSingle();
  if (convCheckError || !existingConv) return 'not-found';

  const adapter = await ChatwootAdapter.forScope(scope);
  if (!adapter) return 'unconfigured';

  const toggleResult = await adapter.toggleConversationStatus(conversationId, status);
  if (toggleResult._tag !== 'ChatwootSuccess') {
    return { failed: toggleResult.message || toggleResult.reason };
  }

  const { error } = await supabaseServer
    .from('chatwoot_conversations')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', conversationId)
    .eq('organizacao_id', scope.organizationId);
  if (error) throw error;
  return 'updated';
}

export async function POST(request: Request) {
  try {
    // 0. Validação de Sessão
    const contextResult = await resolveActiveRequestOrganizationContext(request);
    if (contextResult._tag !== 'OrganizationContextResolved') {
      const responseStatus = organizationContextStatus(contextResult);
      return NextResponse.json(
        { success: false, error: responseStatus === 503 ? 'Serviço de autorização indisponível' : 'Não autorizado' },
        { status: responseStatus },
      );
    }

    const { conversationId, status } = await request.json();

    const parsedConversationId = Number(conversationId);
    const parsedStatus = conversationStatusSchema.safeParse(status);
    if (!Number.isSafeInteger(parsedConversationId) || parsedConversationId <= 0 || !parsedStatus.success) {
      return NextResponse.json(
        { success: false, error: 'Parâmetros conversationId e status são obrigatórios.' },
        { status: 400 }
      );
    }

    const scope = organizationContextToScope(contextResult.context);
    const result = await updateConversationStatus(scope, parsedConversationId, parsedStatus.data);
    if (result === 'not-found') {
      return NextResponse.json(
        { success: false, error: 'Conversa não encontrada' },
        { status: 404 }
      );
    }
    if (result === 'unconfigured') {
      return NextResponse.json(
        { success: false, error: 'Integração Chatwoot não configurada' },
        { status: 409 },
      );
    }
    if (typeof result === 'object') {
      return NextResponse.json(
        { success: false, error: `Falha ao alterar status no Chatwoot: ${result.failed}` },
        { status: 502 },
      );
    }

    return NextResponse.json({ success: true });

  } catch (error: unknown) {
    console.error('❌ Erro na API de alteração de status do Chatwoot:', error);
    const errMsg = error instanceof Error ? error.message : 'Erro ao alterar status da conversa';
    return NextResponse.json(
      { success: false, error: errMsg },
      { status: 500 }
    );
  }
}
