import { NextResponse } from 'next/server';
import { ChatwootAdapter } from '../../../../services/chatwoot/chatwootAdapter';
import { registerChatwootInboxIfNeeded } from '../../../../services/chatwoot/chatwootInboxRegistration';
import type { ChatwootConversation } from '../../../../services/chatwoot/chatwootPort';
import {
  mapChatwootChannel,
  mapChatwootMessageType,
  revisaoDoProvedor,
  senderTypeConhecido,
} from '../../../../services/chatwoot/chatwootWebhookPersistence';
import {
  gravarContato,
  gravarConversa,
  gravarMensagem,
  type EscopoDeEscritaChatwoot,
} from '../../../../services/chatwoot/espelhoChatwoot';
import { criarEspelhoChatwootSupabase } from '../../../../services/chatwoot/espelhoChatwootSupabase';
import { FalhaDeIdentidadeChatwootError } from '../../../../services/chatwoot/identidadeChatwoot';
import { logger } from '../../../../lib/observability/logger';
import { supabaseServer } from '../../../../lib/supabaseServer';
import { organizationContextStatus } from '../../../../lib/organizationAuthorization';
import { resolveActiveRequestOrganizationContext } from '../../../../lib/requestOrganizationContext';
import { normalizeToE164 } from '../../../../lib/utils';
import { registroDoSacSupabase, vincularSacAoErp } from '../../../../services/integrationService';
import { recordAuditEvent } from '../../../../services/auditService';
import { criarAuditoriaComercial } from '../../../../services/auditoriaComercial';
import { getCorrelationId } from '../../../../lib/observability/correlation';
import { organizationContextToScope, type VerifiedOrganizationScope } from '../../../../lib/verifiedOrganizationScope';

export const dynamic = 'force-dynamic';

const espelho = criarEspelhoChatwootSupabase(supabaseServer);

/** Sincroniza todas as mensagens de uma conversa. Retorna a contagem de mensagens persistidas. */
async function syncChatwootMessages(
  adapter: ChatwootAdapter,
  escopo: EscopoDeEscritaChatwoot,
  conversationId: number,
): Promise<number> {
  const messagesResult = await adapter.getMessages(conversationId);
  if (messagesResult._tag !== 'ChatwootSuccess') {
    console.error(`❌ Erro ao consultar mensagens da conversa ${conversationId}:`, messagesResult.reason);
    return 0;
  }

  let messagesCount = 0;
  for (const rawMsg of messagesResult.data) {
    try {
      await gravarMensagem(espelho, escopo, {
        idExterno: rawMsg.id,
        conversaIdExterno: conversationId,
        conteudo: rawMsg.content || '',
        tipo: mapChatwootMessageType(rawMsg.message_type),
        remetenteNome: rawMsg.sender?.name || null,
        remetenteId: rawMsg.sender?.id || null,
        remetenteTipo: senderTypeConhecido(rawMsg.sender?.type),
        criadaEm: rawMsg.created_at || new Date().toISOString(),
        conteudoRevisaoEm: revisaoDoProvedor(rawMsg.updated_at) ?? null,
      }, 'sobrescrever');
      messagesCount++;
    } catch (erro: unknown) {
      registrarRecusa(escopo, erro);
    }
  }
  return messagesCount;
}

/** Uma recusa de identidade pula o registro e é registrada; outra falha sobe. */
function registrarRecusa(escopo: EscopoDeEscritaChatwoot, erro: unknown): void {
  if (!(erro instanceof FalhaDeIdentidadeChatwootError)) throw erro;
  logger.warn('chatwoot.identidade.recusada', {
    subsystem: 'provider',
    organizacaoId: escopo.organizacaoId,
    conexaoId: escopo.conexaoId,
    origem: 'sync',
    recurso: erro.recurso,
    outcome: erro.falha,
  });
}

/** Sincroniza uma única conversa (registro de inbox, contato, conversa e mensagens). */
async function syncChatwootConversationTree(
  adapter: ChatwootAdapter,
  scope: VerifiedOrganizationScope,
  rawConv: ChatwootConversation,
): Promise<{ contacts: number; conversations: number; messages: number }> {
  // Registrar/confirmar o mapeamento inbox->organização usando uma conversa obtida
  // via chamada autenticada com as credenciais da própria organização — nunca a
  // partir de um payload de webhook não verificado.
  if (rawConv.inbox_id) {
    await registerChatwootInboxIfNeeded(supabaseServer, scope, {
      conexaoId: adapter.conexaoId,
      inboxId: rawConv.inbox_id,
    });
  }

  const sender = rawConv.meta?.sender;
  if (!sender) return { contacts: 0, conversations: 0, messages: 0 };

  // Sempre a organização verificada e a conexão do adapter, fixadas no início:
  // trocar a organização ativa durante o sync não muda onde ele grava.
  const escopo = { organizacaoId: scope.organizationId, conexaoId: adapter.conexaoId, atorId: scope.actorId };

  let contatoIdLocal: string;
  try {
    contatoIdLocal = await gravarContato(espelho, escopo, {
      idExterno: sender.id,
      nome: sender.name || 'Cliente Sem Nome',
      email: sender.email || null,
      telefone: sender.phone_number || null,
      telefoneNormalizado: normalizeToE164(sender.phone_number || undefined),
      avatarUrl: sender.avatar_url || sender.thumbnail || null,
    });
  } catch (erro: unknown) {
    registrarRecusa(escopo, erro);
    return { contacts: 0, conversations: 0, messages: 0 };
  }

  try {
    await gravarConversa(espelho, escopo, {
      idExterno: rawConv.id,
      contatoIdLocal,
      contatoIdExterno: sender.id,
      displayId: rawConv.display_id ?? null,
      status: rawConv.status || 'open',
      inboxId: rawConv.inbox_id || null,
      canal: mapChatwootChannel(rawConv.meta?.channel || rawConv.channel_type),
      statusRevisaoEm: revisaoDoProvedor(rawConv.updated_at) ?? null,
    });
  } catch (erro: unknown) {
    registrarRecusa(escopo, erro);
    return { contacts: 1, conversations: 0, messages: 0 };
  }

  const messages = await syncChatwootMessages(adapter, escopo, rawConv.id);
  return { contacts: 1, conversations: 1, messages };
}

export async function POST(request: Request) {
  try {
    // 0. Validação de Sessão
    const contextResult = await resolveActiveRequestOrganizationContext(request);
    if (contextResult._tag !== 'OrganizationContextResolved') {
      const status = organizationContextStatus(contextResult);
      return NextResponse.json(
        { success: false, error: status === 503 ? 'Serviço de autorização indisponível' : 'Não autorizado' },
        { status },
      );
    }

    const scope = organizationContextToScope(contextResult.context);

    // 1. Obter conversas da API do Chatwoot usando adapter vinculado ao escopo verificado
    const adapter = await ChatwootAdapter.forScope(scope);
    if (!adapter) {
      return NextResponse.json({ success: false, error: 'Integração Chatwoot não configurada' }, { status: 409 });
    }

    const conversationsResult = await adapter.getConversations();
    if (conversationsResult._tag !== 'ChatwootSuccess') {
      return NextResponse.json(
        { success: false, error: conversationsResult.message || `Falha ao consultar Chatwoot (${conversationsResult.reason})` },
        { status: conversationsResult.status || 502 },
      );
    }
    const rawConversations: ChatwootConversation[] = conversationsResult.data;

    let contactsCount = 0;
    let conversationsCount = 0;
    let messagesCount = 0;

    for (const rawConv of rawConversations) {
      const result = await syncChatwootConversationTree(adapter, scope, rawConv);
      contactsCount += result.contacts;
      conversationsCount += result.conversations;
      messagesCount += result.messages;
    }

    // 2. Auto-registro SAC → ERP: qualquer membro que sincroniza o SAC
    // (`organization:access`), só cria cliente novo, sob trava, e audita.
    const auditar = criarAuditoriaComercial((s, input) => recordAuditEvent(supabaseServer, s, input));
    let clientes: { criados: number; falhas: number } | null = null;
    try {
      const vinculo = await vincularSacAoErp(scope, registroDoSacSupabase, auditar, getCorrelationId(request));
      clientes = { criados: vinculo.criados, falhas: vinculo.falhas };
    } catch (erro: unknown) {
      // As conversas já foram espelhadas: a falha do vínculo não desfaz isso,
      // e a resposta diz que ele não foi feito em vez de fingir sucesso.
      console.error('❌ Erro no vínculo SAC-ERP:', erro instanceof Error ? erro.name : 'UnknownError');
    }

    return NextResponse.json({
      success: true,
      stats: {
        contacts: contactsCount,
        conversations: conversationsCount,
        messages: messagesCount,
      },
      clientes: clientes ?? { criados: 0, falhas: null, vinculo: 'nao_concluido' },
    });

  } catch (error: unknown) {
    console.error('❌ Erro na API de sincronização do Chatwoot:', error);
    const errMsg = error instanceof Error ? error.message : 'Erro interno na sincronização do Chatwoot';
    return NextResponse.json(
      { success: false, error: errMsg },
      { status: 500 }
    );
  }
}
