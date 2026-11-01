import { logger } from '../../lib/observability/logger';
import { traduzirEventoDaInbox, type ComandoDeConsumoChatwoot } from './chatwootWebhookPersistence';

/**
 * Consumidor da inbox do Chatwoot (MSG-006). Uma passada: reivindica um lote
 * curto e aplica cada evento numa transação do banco. O estado é todo do
 * Postgres: uma queda aqui em qualquer ponto só deixa uma lease para vencer.
 *
 * Fatia sem efeito externo: nada aqui chama o Chatwoot.
 */

export interface EventoReivindicado {
  readonly eventoId: string;
  readonly organizacaoId: string;
  readonly conexaoId: string | null;
  readonly inboxId: number | null;
  readonly eventType: string;
  readonly payload: unknown;
  readonly correlationId: string | null;
  readonly fencingToken: number;
  readonly tentativa: number;
}

export type DisposicaoDoEvento =
  | 'caso_aberto'
  | 'mensagem_no_caso'
  | 'espelho_atualizado'
  | 'revisao_atrasada'
  | 'conversa_nao_espelhada'
  | 'conexao_nao_comprovada'
  | 'evento_desconhecido'
  | 'conexao_removida';

export type DesfechoDaAplicacao =
  | { readonly _tag: 'Aplicado'; readonly disposicao: DisposicaoDoEvento; readonly casoId: string | null }
  | { readonly _tag: 'PossePerdida' }
  | { readonly _tag: 'ConexaoDesligada' }
  /** A transação abortou inteira. `codigo` é o SQLSTATE, sem texto do banco. */
  | { readonly _tag: 'FalhaDaTransacao'; readonly codigo: string };

/** A única superfície privilegiada do worker: as três RPCs do consumo, nada mais. */
export interface PortaDoConsumidorInbox {
  reivindicar(workerId: string, limite: number, leaseSegundos: number): Promise<readonly EventoReivindicado[]>;
  aplicar(evento: EventoReivindicado, workerId: string, comando: ComandoDeConsumoChatwoot): Promise<DesfechoDaAplicacao>;
  registrarFalha(evento: EventoReivindicado, workerId: string, codigo: string, definitiva: boolean): Promise<boolean>;
}

export interface ResumoDaPassada {
  readonly reivindicados: number;
  readonly processados: number;
  readonly ignorados: number;
  readonly falhas: number;
  readonly cercados: number;
  readonly devolvidos: number;
  readonly semResposta: number;
}

export interface OpcoesDaPassada {
  readonly workerId: string;
  readonly limite: number;
  readonly leaseSegundos: number;
  readonly deveParar?: () => boolean;
}

type Contagem = { -readonly [K in keyof ResumoDaPassada]: ResumoDaPassada[K] };

const DISPOSICOES_IGNORADAS: ReadonlySet<DisposicaoDoEvento> = new Set([
  'conversa_nao_espelhada', 'conexao_nao_comprovada', 'evento_desconhecido', 'conexao_removida',
]);

function contexto(evento: EventoReivindicado) {
  return {
    subsystem: 'queue' as const,
    correlationId: evento.correlationId ?? undefined,
    organizacaoId: evento.organizacaoId,
    conexaoId: evento.conexaoId ?? undefined,
    inboxEventoId: evento.eventoId,
    recurso: evento.eventType,
    fencingToken: evento.fencingToken,
    tentativa: evento.tentativa,
  };
}

async function falhar(
  porta: PortaDoConsumidorInbox,
  evento: EventoReivindicado,
  workerId: string,
  codigo: string,
  definitiva: boolean,
  contagem: Contagem,
) {
  const gravou = await porta.registrarFalha(evento, workerId, codigo, definitiva);
  if (gravou) contagem.falhas++;
  else contagem.cercados++;
  logger.warn('chatwoot.inbox.falha', { ...contexto(evento), outcome: gravou ? codigo : 'posse_perdida', definitiva });
}

async function processar(porta: PortaDoConsumidorInbox, evento: EventoReivindicado, workerId: string, contagem: Contagem) {
  logger.info('chatwoot.inbox.inicio', contexto(evento));

  const traducao = traduzirEventoDaInbox(evento.eventType, evento.inboxId, evento.payload);
  if (traducao._tag === 'PayloadInvalido') {
    await falhar(porta, evento, workerId, traducao.codigo, true, contagem);
    return;
  }

  const desfecho = await porta.aplicar(evento, workerId, traducao.comando);
  switch (desfecho._tag) {
    case 'Aplicado':
      if (DISPOSICOES_IGNORADAS.has(desfecho.disposicao)) contagem.ignorados++;
      else contagem.processados++;
      logger.info('chatwoot.inbox.termino', { ...contexto(evento), outcome: desfecho.disposicao, casoId: desfecho.casoId ?? undefined });
      return;
    case 'PossePerdida':
      contagem.cercados++;
      logger.warn('chatwoot.inbox.recusada', { ...contexto(evento), outcome: 'posse_perdida' });
      return;
    case 'ConexaoDesligada':
      contagem.devolvidos++;
      logger.info('chatwoot.inbox.recusada', { ...contexto(evento), outcome: 'conexao_desligada' });
      return;
    case 'FalhaDaTransacao':
      await falhar(porta, evento, workerId, `falha_${desfecho.codigo.toLowerCase()}`, false, contagem);
      return;
  }
}

/** Uma passada. Ao pedir parada, os eventos restantes do lote ficam para a lease vencer. */
export async function consumirInboxUmaVez(porta: PortaDoConsumidorInbox, opcoes: OpcoesDaPassada): Promise<ResumoDaPassada> {
  const lote = await porta.reivindicar(opcoes.workerId, opcoes.limite, opcoes.leaseSegundos);
  const contagem: Contagem = { reivindicados: lote.length, processados: 0, ignorados: 0, falhas: 0, cercados: 0, devolvidos: 0, semResposta: 0 };
  for (const evento of lote) {
    if (opcoes.deveParar?.()) break;
    try {
      await processar(porta, evento, opcoes.workerId, contagem);
    } catch {
      // Sem resposta do banco: a transação pode ou não ter commitado. A lease
      // vence e o claim só retoma o evento se ele não estiver concluído.
      contagem.semResposta++;
      logger.error('chatwoot.inbox.sem_resposta', contexto(evento));
    }
  }
  return contagem;
}
