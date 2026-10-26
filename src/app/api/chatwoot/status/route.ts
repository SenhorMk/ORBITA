import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ChatwootAdapter } from '../../../../services/chatwoot/chatwootAdapter';
import { supabaseServer } from '../../../../lib/supabaseServer';
import { organizationContextStatus } from '../../../../lib/organizationAuthorization';
import { resolveActiveRequestOrganizationContext } from '../../../../lib/requestOrganizationContext';
import { organizationContextToScope, type VerifiedOrganizationScope } from '../../../../lib/verifiedOrganizationScope';
import { criarEspelhoChatwootSupabase } from '../../../../services/chatwoot/espelhoChatwootSupabase';
import { resolverPorIdLocal, type FalhaDeIdentidadeChatwoot } from '../../../../services/chatwoot/identidadeChatwoot';

export const dynamic = 'force-dynamic';
const conversationStatusSchema = z.enum(['open', 'resolved', 'pending']);

/** O navegador referencia a conversa só pelo UUID local; id remoto não é aceito. */
const StatusSchema = z.object({
  conversaId: z.string().uuid(),
  status: conversationStatusSchema,
});

const espelho = criarEspelhoChatwootSupabase(supabaseServer);

type UpdateConversationStatusResult =
  | 'updated'
  | 'unconfigured'
  | { readonly naoTraduzida: FalhaDeIdentidadeChatwoot }
  | { readonly failed: string };

async function updateConversationStatus(
  scope: VerifiedOrganizationScope,
  conversaId: string,
  status: z.infer<typeof conversationStatusSchema>,
): Promise<UpdateConversationStatusResult> {
  // Organização da sessão; conexão e id remoto da própria conversa, no servidor.
  const conversa = await resolverPorIdLocal(espelho, scope.organizationId, 'conversa', conversaId);
  if (conversa._tag === 'IdLocalNaoTraduzido') return { naoTraduzida: conversa.falha };

  const adapter = await ChatwootAdapter.forScope(scope, conversa.escopo.conexaoId);
  if (!adapter) return 'unconfigured';

  const toggleResult = await adapter.toggleConversationStatus(conversa.idExterno, status);
  if (toggleResult._tag !== 'ChatwootSuccess') {
    return { failed: toggleResult.message || toggleResult.reason };
  }

  const atualizacao = await espelho.atualizar('conversa', conversa.escopo, conversaId, {
    status,
    updated_at: new Date().toISOString(),
  });
  if (atualizacao._tag === 'StoreFalhou') throw new Error('O status mudou no Chatwoot, mas o espelho local não foi atualizado.');
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

    const parsed = StatusSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: 'Parâmetros conversaId (UUID local) e status são obrigatórios.' },
        { status: 400 }
      );
    }

    const scope = organizationContextToScope(contextResult.context);
    const result = await updateConversationStatus(scope, parsed.data.conversaId, parsed.data.status);
    if (typeof result === 'object' && 'naoTraduzida' in result) {
      const naoEncontrada = result.naoTraduzida === 'IdentidadeNaoEncontrada';
      return NextResponse.json(
        { success: false, error: naoEncontrada ? 'Conversa não encontrada' : 'Conversa sem identidade Chatwoot resolvida', motivo: result.naoTraduzida },
        { status: naoEncontrada ? 404 : result.naoTraduzida === 'StoreIndisponivel' ? 503 : 422 }
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
