/**
 * O desfecho de um efeito externo despachado pela outbox (MSG-007).
 *
 * Quatro desfechos, e só o adapter — que conhece o contrato do provedor —
 * decide qual:
 *
 * - `NaoEnviado`: há prova de que o transporte não começou, ou o contrato do
 *   provedor documenta que a resposta garante não aplicação. Volta à fila.
 * - `Recusado`: o provedor recusou de forma definitiva. Terminal.
 * - `Confirmado`: o provedor devolveu um recibo (a referência do efeito).
 * - `Desconhecido`: o pedido pode ter sido aplicado. Timeout, ACK perdido,
 *   resposta inválida (inclusive 2xx inválido), 5xx e falha depois do despacho
 *   caem aqui. Não há retry automático: só reconciliação ou replay autorizado
 *   depois de provada a não aplicação.
 *
 * Nenhuma decisão de repetir sai de texto de erro: `classifyError` continua
 * existindo para categorizar e redigir mensagens, nunca para escolher retry.
 */
import { z } from 'zod';

import type { ChatwootApiResult, ChatwootMessage } from '../chatwoot/chatwootPort';

/** Motivos de `unknown`, espelho do CHECK `ck_outbox_eventos_motivo_bloqueio`. */
export const MOTIVOS_DESCONHECIDO = [
  'timeout',
  'ack_perdido',
  'resposta_invalida',
  'erro_do_provedor',
  'limite_sem_prova',
  'falha_apos_despacho',
  'lease_expirada_em_voo',
  'envio_inline_legado',
] as const;
export type MotivoDesconhecido = (typeof MOTIVOS_DESCONHECIDO)[number];

const codigo = z.string().regex(/^[a-z0-9_]{1,64}$/u);
const erro = z.string().max(500);

/** O que um adapter pode devolver. O worker valida antes de gravar. */
export const DesfechoDoDespachoSchema = z.discriminatedUnion('_tag', [
  z.object({
    _tag: z.literal('Confirmado'),
    recibo: z.string().trim().min(1).max(200),
    resposta: z.record(z.string(), z.unknown()).nullable().optional(),
  }),
  z.object({
    _tag: z.literal('NaoEnviado'),
    prova: z.enum(['transporte_nao_iniciado', 'nao_aplicacao_documentada']),
    retryAfterSeconds: z.number().int().min(1).max(86_400).optional(),
    erro,
  }),
  z.object({
    _tag: z.literal('Recusado'),
    categoria: z.enum(['permanent', 'auth_expired']),
    codigo,
    erro,
  }),
  z.object({
    _tag: z.literal('Desconhecido'),
    motivo: z.enum(MOTIVOS_DESCONHECIDO),
    erro,
  }),
]);
export type DesfechoDoDespacho = z.infer<typeof DesfechoDoDespachoSchema>;

/**
 * Valida o que o adapter devolveu. Um desfecho fora do contrato — inclusive um
 * "confirmado" sem recibo — não é sucesso: o despacho já começou, então vira
 * `Desconhecido`.
 */
export function validarDesfecho(bruto: unknown): DesfechoDoDespacho {
  const parsed = DesfechoDoDespachoSchema.safeParse(bruto);
  if (parsed.success) return parsed.data;
  return { _tag: 'Desconhecido', motivo: 'resposta_invalida', erro: 'Desfecho do adapter fora do contrato.' };
}

/** Exceção depois de iniciado o despacho: o efeito pode ter acontecido. */
export function desfechoDeFalhaAposDespacho(): DesfechoDoDespacho {
  return { _tag: 'Desconhecido', motivo: 'falha_apos_despacho', erro: 'O adapter falhou depois de iniciar o despacho.' };
}

/**
 * O envio de mensagem do Chatwoot (`POST .../messages`) como desfecho.
 *
 * O contrato do Chatwoot não oferece chave de idempotência nem documenta que
 * 429 ou 5xx garantem não aplicação, e `fetch` não distingue falha de conexão
 * antes ou depois do envio. Por isso só 4xx definitivo é recusa, e todo o
 * resto que não traz recibo é desconhecido.
 */
export function desfechoDoEnvioChatwoot(resultado: ChatwootApiResult<ChatwootMessage>): DesfechoDoDespacho {
  if (resultado._tag === 'ChatwootSuccess') {
    return { _tag: 'Confirmado', recibo: String(resultado.data.id), resposta: { id: resultado.data.id } };
  }
  switch (resultado.reason) {
    case 'timeout':
      return { _tag: 'Desconhecido', motivo: 'timeout', erro: 'Sem resposta do Chatwoot dentro do prazo.' };
    case 'network':
      return { _tag: 'Desconhecido', motivo: 'ack_perdido', erro: 'A conexão caiu sem resposta do Chatwoot.' };
    case 'invalid-response':
      return { _tag: 'Desconhecido', motivo: 'resposta_invalida', erro: 'Resposta do Chatwoot fora do contrato.' };
    case 'rate-limited':
      return { _tag: 'Desconhecido', motivo: 'limite_sem_prova', erro: 'Chatwoot respondeu 429; o contrato não prova não aplicação.' };
    case 'unconfigured':
      return { _tag: 'Recusado', categoria: 'permanent', codigo: 'nao_configurado', erro: 'Chatwoot não configurado.' };
    case 'http': {
      const status = resultado.status ?? 0;
      if (status === 401 || status === 403) {
        return { _tag: 'Recusado', categoria: 'auth_expired', codigo: `http_${status}`, erro: `Chatwoot recusou a credencial (${status}).` };
      }
      if (status >= 400 && status < 500) {
        return { _tag: 'Recusado', categoria: 'permanent', codigo: `http_${status}`, erro: `Chatwoot recusou o envio (${status}).` };
      }
      return { _tag: 'Desconhecido', motivo: 'erro_do_provedor', erro: `Chatwoot respondeu ${status || 'sem status'}.` };
    }
  }
}

/** Por que um efeito desconhecido não pode ser repetido, na língua do operador. */
const EXPLICACAO_DO_MOTIVO: Readonly<Record<MotivoDesconhecido, string>> = {
  timeout: 'O provedor não respondeu a tempo. A mensagem pode ter sido entregue.',
  ack_perdido: 'A conexão caiu antes da confirmação. A mensagem pode ter sido entregue.',
  resposta_invalida: 'O provedor respondeu fora do contrato. Não há prova de entrega nem de falha.',
  erro_do_provedor: 'O provedor respondeu com erro interno. O pedido pode ter sido aplicado.',
  limite_sem_prova: 'O provedor limitou a taxa, e o contrato dele não prova que o pedido foi descartado.',
  falha_apos_despacho: 'O envio falhou depois de sair do ORBITA. O pedido pode ter sido aplicado.',
  lease_expirada_em_voo: 'O processo de envio parou no meio do despacho. O pedido pode ter sido aplicado.',
  envio_inline_legado: 'Envio anterior a esta versão, sem registro do desfecho. Pode ter sido entregue.',
};

export interface EstadoParaOperador {
  readonly status: string;
  readonly motivoBloqueio: string | null;
  readonly resolucao: string | null;
}

/** O desfecho de um evento como a tela o mostra. */
export type DesfechoVisivel = 'nao_enviado' | 'recusado' | 'confirmado' | 'desconhecido' | 'em_andamento';

export function desfechoVisivel(status: string): DesfechoVisivel {
  if (status === 'sent') return 'confirmado';
  if (status === 'dead_letter') return 'recusado';
  if (status === 'unknown') return 'desconhecido';
  if (status === 'pending' || status === 'failed_transient') return 'nao_enviado';
  return 'em_andamento';
}

/** Replay só depois de provada a não aplicação; o servidor confere de novo. */
export function podeRepetir(evento: EstadoParaOperador): boolean {
  return evento.status === 'unknown' && evento.resolucao === 'provado_nao_aplicado';
}

/** A frase que explica ao operador o que pode e o que não pode ser feito. */
export function explicarEstado(evento: EstadoParaOperador): string {
  if (evento.status === 'unknown') {
    const porque = (MOTIVOS_DESCONHECIDO as readonly string[]).includes(evento.motivoBloqueio ?? '')
      ? EXPLICACAO_DO_MOTIVO[evento.motivoBloqueio as MotivoDesconhecido]
      : 'O pedido pode ter sido aplicado.';
    if (evento.resolucao === 'provado_nao_aplicado') {
      return `${porque} A não aplicação foi comprovada; o reenvio pode ser autorizado.`;
    }
    if (evento.resolucao === 'revisao_manual') {
      return `${porque} Em revisão manual. Não reenvie: confira no provedor e registre o resultado.`;
    }
    return `${porque} Não reenvie: confira no provedor e registre o resultado.`;
  }
  if (evento.status === 'dead_letter') {
    return 'Recusado. Repetir o mesmo pedido falharia de novo; corrija a causa e faça um novo envio.';
  }
  if (evento.status === 'in_flight' || evento.status === 'processing') {
    return 'Envio em andamento. Aguarde o desfecho.';
  }
  if (evento.status === 'sent') return 'Confirmado pelo provedor.';
  return 'Ainda não enviado. A fila tenta de novo sozinha.';
}
