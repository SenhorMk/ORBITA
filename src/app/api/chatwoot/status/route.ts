import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ChatwootClient } from '../../../../services/chatwoot';
import { supabaseServer } from '../../../../lib/supabaseServer';
import { organizationContextStatus } from '../../../../lib/organizationAuthorization';
import { resolveActiveRequestOrganizationContext } from '../../../../lib/requestOrganizationContext';
import { organizationContextToScope, type VerifiedOrganizationScope } from '../../../../lib/verifiedOrganizationScope';

export const dynamic = 'force-dynamic';
const conversationStatusSchema = z.enum(['open', 'resolved', 'pending']);

async function updateConversationStatus(
  scope: VerifiedOrganizationScope,
  conversationId: number,
  status: z.infer<typeof conversationStatusSchema>,
): Promise<'updated' | 'not-found'> {
  const { data: existingConv, error: convCheckError } = await supabaseServer
    .from('chatwoot_conversations')
    .select('id')
    .eq('id', conversationId)
    .eq('organizacao_id', scope.organizationId)
    .maybeSingle();
  if (convCheckError || !existingConv) return 'not-found';

  const client = await ChatwootClient.forOrganization(scope);
  await client.toggleStatusInApi(conversationId, status);
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
    if (await updateConversationStatus(scope, parsedConversationId, parsedStatus.data) === 'not-found') {
      return NextResponse.json(
        { success: false, error: 'Conversa não encontrada' },
        { status: 404 }
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
