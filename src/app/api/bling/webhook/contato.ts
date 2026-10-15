import { clienteRepository } from '../../../../repositories/clienteRepository';
import { logger } from '../../../../lib/observability/logger';
import { normalizeToE164 } from '../../../../lib/utils';
import type { VerifiedOrganizationScope } from '../../../../lib/verifiedOrganizationScope';
import type { Cliente } from '../../../../types';
import { dataDoEventoDoBling, idDoBlingSchema } from './eventoDoBling';

/** Texto não vazio do payload, ou `undefined`. */
function texto(valor: unknown): string | undefined {
  return typeof valor === 'string' && valor.trim() !== '' ? valor.trim() : undefined;
}

/**
 * Exclusão de contato: a ação de `contact.deleted` (e variantes) ou um
 * `contact.updated` com a situação `E` (Excluído) do Bling.
 */
function ehExclusao(entity: string, dados: Record<string, unknown>): boolean {
  const acao = entity.split('.')[1] ?? '';
  return acao.includes('delet') || acao.includes('exclu') || acao.includes('remov') || dados.situacao === 'E';
}

/**
 * Aplica um evento de contato do Bling (PRE-005) e devolve o desfecho que o
 * inbox registra.
 *
 * - **Exclusão** vem antes de qualquer leitura ou upsert: o contato local é
 *   marcado como excluído (`registrar_exclusao_de_contato_no_bling`), nunca
 *   apagado nem recriado. A reentrega responde `ja_registrado`.
 * - **Atualização de contato excluído** é ignorada e auditada: só a
 *   reativação explícita o traz de volta. O banco recusa a gravação de
 *   qualquer jeito (23514); conferir antes evita a falha e a reentrega.
 * - **Sem nome no payload**, o nome é o já gravado; contato desconhecido sem
 *   nome não é criado. Nunca `Cliente #<id>`.
 * - Id que não é do Bling é ignorado e auditado. Falha do banco sobe para o
 *   inbox marcar `failed` e o Bling reentregar.
 *
 * @param correlationId - A chave de idempotência do evento no inbox.
 */
export async function processarEventoDeContato(
  entity: string,
  eventRecord: Record<string, unknown>,
  eventData: Record<string, unknown>,
  organizationScope: VerifiedOrganizationScope,
  correlationId: string,
): Promise<Record<string, unknown>> {
  const dados = (eventData.contato || eventData) as Record<string, unknown>;
  const contexto = { subsystem: 'provider' as const, provider: 'bling', correlationId, organizacaoId: organizationScope.organizationId };
  const id = idDoBlingSchema.safeParse(dados.id ?? dados.bling_id);
  if (!id.success) {
    logger.warn('bling_webhook.contato.recusado', { ...contexto, outcome: 'id_invalido' });
    return { success: true, ignored: true, reason: 'id_invalido' };
  }
  const blingId = id.data;

  if (ehExclusao(entity, dados)) {
    const desfecho = await clienteRepository.registrarExclusaoNoBling(organizationScope, blingId, dataDoEventoDoBling(eventRecord));
    logger.info('bling_webhook.contato_excluido.registrado', { ...contexto, blingId, outcome: desfecho });
    return { success: true, entity: 'contato', acao: 'excluido_no_bling', blingId, desfecho };
  }

  if (await clienteRepository.exclusaoVigenteNoBling(organizationScope, blingId)) {
    logger.info('bling_webhook.contato.ignorado', { ...contexto, blingId, outcome: 'excluido_no_bling' });
    return { success: true, ignored: true, reason: 'excluido_no_bling', blingId };
  }

  const nome = texto(dados.nome) ?? (await clienteRepository.getByBlingId(organizationScope, blingId))?.nome;
  if (!nome) {
    logger.warn('bling_webhook.contato.ignorado', { ...contexto, blingId, outcome: 'contato_sem_nome' });
    return { success: true, ignored: true, reason: 'contato_sem_nome', blingId };
  }

  const tel = texto(dados.telefone) ?? texto(dados.celular);
  const cliente: Cliente = {
    bling_id: blingId,
    nome,
    cpf_cnpj: texto(dados.cnpj) ?? texto(dados.numeroDocumento),
    email: texto(dados.email),
    telefone: tel,
    telefone_normalizado: normalizeToE164(tel) || undefined,
  };
  await clienteRepository.upsert(organizationScope, cliente);
  return { success: true, entity: 'contato', blingId };
}
