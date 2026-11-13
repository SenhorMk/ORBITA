/**
 * Uma passada do worker de triagem (MSG-013).
 *
 * Protocolo: liberar leases vencidas → reivindicar só `interno/sac.triagem` →
 * para cada item, iniciar no banco (posse, versão do caso, orçamento) → chamar
 * o modelo fora de qualquer transação → concluir no banco (revalida a versão e
 * fecha o evento na mesma transação). O banco decide posse, obsolescência e
 * orçamento; aqui só se orquestra. Os logs levam ids, desfecho e uso, nunca o
 * texto das mensagens nem o resultado.
 */
import type { MotivoSemTriagem, TriagemV1 } from '../../../lib/integrations/contratoDaTriagem';
import { VERSAO_DO_SCHEMA_DA_TRIAGEM } from '../../../lib/integrations/contratoDaTriagem';
import { logger } from '../../../lib/observability/logger';

import {
  executarTriagem,
  VERSAO_DO_PROMPT_DA_TRIAGEM,
  type DesfechoDaTriagem,
  type MensagemDoContato,
  type ModeloDeTriagem,
} from './triagemDoCaso';

export interface TriagemReivindicada {
  readonly eventoId: string;
  readonly organizacaoId: string;
  readonly casoId: string;
  readonly correlationId: string | null;
  readonly fencingToken: number;
}

export type InicioDaTriagem =
  | { readonly _tag: 'Iniciada'; readonly runId: string; readonly mensagens: readonly MensagemDoContato[] }
  | { readonly _tag: 'Encerrada'; readonly motivo: 'obsoleta' | 'sem_orcamento' | 'caso_inexistente' | 'posse_perdida' };

export type ResultadoDaConclusao = 'concluida' | 'handoff' | 'falha' | 'obsoleta' | 'posse_perdida';

export interface ConclusaoDaTriagem {
  readonly status: 'concluida' | 'handoff' | 'falha';
  readonly motivo: MotivoSemTriagem | null;
  readonly triagem: TriagemV1 | null;
  readonly chamouModelo: boolean;
  readonly tokensEntrada: number | null;
  readonly tokensSaida: number | null;
  readonly reparos: 0 | 1;
  readonly latenciaMs: number;
  readonly repetirEmSegundos: number;
}

export interface PortaDoConsumidorTriagem {
  liberarLeasesVencidas(): Promise<number>;
  reivindicar(pedido: { readonly workerId: string; readonly limite: number; readonly leaseSegundos: number }): Promise<readonly TriagemReivindicada[]>;
  iniciar(item: TriagemReivindicada, pedido: {
    readonly workerId: string;
    readonly limiteDiario: number;
    readonly provedor: string;
    readonly modelo: string;
    readonly versaoPrompt: string;
    readonly versaoSchema: number;
  }): Promise<InicioDaTriagem>;
  concluir(runId: string, workerId: string, fencingToken: number, conclusao: ConclusaoDaTriagem): Promise<ResultadoDaConclusao>;
}

export interface OpcoesDaPassada {
  readonly workerId: string;
  readonly limite: number;
  readonly leaseSegundos: number;
  readonly limiteDiario: number;
  readonly timeoutMs: number;
  readonly deveParar?: () => boolean;
  readonly relogio?: () => number;
}

export interface ResumoDaPassada {
  readonly reaped: number;
  readonly reivindicados: number;
  readonly concluidas: number;
  readonly handoffs: number;
  readonly falhas: number;
  readonly encerradas: number;
}

function conclusaoDe(desfecho: DesfechoDaTriagem, latenciaMs: number): ConclusaoDaTriagem {
  return {
    status: desfecho.status,
    motivo: desfecho.status === 'concluida' ? null : desfecho.motivo,
    triagem: desfecho.status === 'concluida' ? desfecho.triagem : null,
    chamouModelo: desfecho.chamouModelo,
    tokensEntrada: desfecho.uso.entrada,
    tokensSaida: desfecho.uso.saida,
    reparos: desfecho.reparos,
    latenciaMs,
    repetirEmSegundos: desfecho.status === 'falha' ? desfecho.repetirEmSegundos : 30,
  };
}

export async function consumirTriagensUmaVez(
  porta: PortaDoConsumidorTriagem,
  modelo: ModeloDeTriagem,
  opcoes: OpcoesDaPassada,
): Promise<ResumoDaPassada> {
  const relogio = opcoes.relogio ?? Date.now;
  const reaped = await porta.liberarLeasesVencidas();
  const itens = await porta.reivindicar({ workerId: opcoes.workerId, limite: opcoes.limite, leaseSegundos: opcoes.leaseSegundos });
  const contagem = { concluidas: 0, handoffs: 0, falhas: 0, encerradas: 0 };

  for (const item of itens) {
    if (opcoes.deveParar?.()) break;
    const base = { subsystem: 'queue' as const, correlationId: item.correlationId ?? undefined, organizacaoId: item.organizacaoId, casoId: item.casoId, eventoId: item.eventoId };
    const inicio = await porta.iniciar(item, {
      workerId: opcoes.workerId,
      limiteDiario: opcoes.limiteDiario,
      provedor: modelo.provedor,
      modelo: modelo.modelo,
      versaoPrompt: VERSAO_DO_PROMPT_DA_TRIAGEM,
      versaoSchema: VERSAO_DO_SCHEMA_DA_TRIAGEM,
    });
    if (inicio._tag === 'Encerrada') {
      contagem.encerradas += 1;
      logger.info('sac.triagem.encerrada', { ...base, outcome: inicio.motivo });
      continue;
    }

    logger.info('sac.triagem.iniciada', { ...base, runId: inicio.runId, provedor: modelo.provedor, modelo: modelo.modelo, mensagens: inicio.mensagens.length });
    const comeco = relogio();
    const desfecho = await executarTriagem(inicio.mensagens, modelo, { timeoutMs: opcoes.timeoutMs });
    const conclusao = conclusaoDe(desfecho, Math.max(relogio() - comeco, 0));
    const gravado = await porta.concluir(inicio.runId, opcoes.workerId, item.fencingToken, conclusao);

    if (gravado === 'concluida') contagem.concluidas += 1;
    else if (gravado === 'falha') contagem.falhas += 1;
    else if (gravado === 'handoff') contagem.handoffs += 1;
    else contagem.encerradas += 1;

    const campos = {
      ...base, runId: inicio.runId, outcome: gravado, motivo: conclusao.motivo, reparos: conclusao.reparos,
      tokensEntrada: conclusao.tokensEntrada, tokensSaida: conclusao.tokensSaida, latenciaMs: conclusao.latenciaMs,
      precisaDeHumano: conclusao.triagem?.precisaDeHumano ?? null,
    };
    if (gravado === 'concluida' || gravado === 'obsoleta') logger.info('sac.triagem.concluida', campos);
    else logger.warn('sac.triagem.sem_resultado', campos);
  }

  return { reaped, reivindicados: itens.length, ...contagem };
}
