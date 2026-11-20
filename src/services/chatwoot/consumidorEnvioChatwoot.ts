/**
 * O consumidor do envio ao Chatwoot (MSG-008): uma passada do worker.
 *
 * Protocolo da outbox (MSG-007), sem atalho: liberar leases vencidas →
 * reivindicar só envios registrados desde o corte → resolver o canal (autor
 * ainda membro, conexão ligada) → gravar `in_flight` → POST ao Chatwoot →
 * concluir por fencing. Desde o MSG-009, gravar `in_flight` confere a versão do
 * controle do atendimento sob trava: uma versão vencida (alguém assumiu ou
 * devolveu depois do registro) invalida o envio no banco, sem chamar o
 * Chatwoot. Nota privada sai pelo método privado e só é confirmada se o
 * recibo disser `private`. Só um recibo confirma, e a mensagem espelhada nasce na
 * mesma transação da confirmação. Timeout, ACK perdido, 2xx inválido, 5xx, 429
 * e exceção depois do despacho viram `unknown`, que nenhum claim reenvia; uma
 * queda antes de gravar o desfecho deixa `in_flight`, que o reaper leva a
 * `unknown`. Nada aqui repete um POST de desfecho desconhecido.
 */
import { logger } from '../../lib/observability/logger';
import type { ChatwootApiResult, ChatwootMessage } from './chatwootPort';
import {
  desfechoDeFalhaAposDespacho,
  desfechoDoEnvioChatwoot,
  validarDesfecho,
  type DesfechoDoDespacho,
} from '../outbox/desfechoDoEfeito';

export interface EnvioReivindicado {
  readonly eventoId: string;
  readonly organizacaoId: string;
  readonly conexaoId: string;
  readonly envioId: string;
  readonly atorId: string | null;
  readonly conversaIdExterno: number;
  readonly conteudo: string;
  /** Nota privada do Chatwoot (MSG-009): nunca vai à cliente. */
  readonly privada: boolean;
  readonly correlationId: string | null;
  readonly fencingToken: number;
}

export interface PosseDoEnvio {
  readonly eventoId: string;
  readonly workerId: string;
  readonly fencingToken: number;
}

/** O que o recibo do Chatwoot devolveu sobre a mensagem, sem o conteúdo. */
export interface MensagemDoRecibo {
  readonly remetenteNome: string | null;
  readonly remetenteId: number | null;
  readonly remetenteTipo: string | null;
  readonly criadaEm: string | null;
}

/**
 * O canal de uma conexão: só o envio, para o worker não alcançar mais nada.
 * Mensagem e nota privada são métodos distintos: nenhum parâmetro decide se o
 * texto vai à cliente.
 */
export interface CanalDeEnvio {
  sendMessage(conversaIdExterno: number, conteudo: string): Promise<ChatwootApiResult<ChatwootMessage>>;
  sendPrivateNote(conversaIdExterno: number, conteudo: string): Promise<ChatwootApiResult<ChatwootMessage>>;
}

/** `invalidado`: o controle mudou depois do registro; o banco já gravou o desfecho. */
export type InicioDoDespacho = 'iniciado' | 'invalidado' | 'posse_perdida' | 'aguardando_ai_first';

export type ResolucaoDoCanal =
  | { readonly _tag: 'Canal'; readonly canal: CanalDeEnvio }
  | { readonly _tag: 'SemVinculo' }
  | { readonly _tag: 'NaoConfigurado' };

export interface PortaDoConsumidorEnvio {
  liberarLeasesVencidas(): Promise<number>;
  reivindicar(pedido: {
    readonly workerId: string;
    readonly limite: number;
    readonly leaseSegundos: number;
    readonly criadosDesde: string;
  }): Promise<readonly EnvioReivindicado[]>;
  /** Quem pediu ainda é membro e a conexão está ligada? Lido antes da rede. */
  resolverCanal(envio: EnvioReivindicado): Promise<ResolucaoDoCanal>;
  iniciarDespacho(posse: PosseDoEnvio): Promise<InicioDoDespacho>;
  /** Status gravado, ou `null` quando o fencing recusou. */
  concluir(posse: PosseDoEnvio, desfecho: DesfechoDoDespacho, mensagem: MensagemDoRecibo | null): Promise<string | null>;
}

export interface ResumoDoEnvio {
  readonly reaped: number;
  readonly reivindicados: number;
  readonly enviados: number;
  readonly recusados: number;
  readonly repetiveis: number;
  readonly desconhecidos: number;
  /** Invalidados pelo controle do atendimento antes da rede (MSG-009). */
  readonly invalidados: number;
  /** Posse perdida antes do despacho ou recusada na conclusão. */
  readonly semPosse: number;
  /** Desfecho que não chegou ao banco: fica `in_flight` até o reaper. */
  readonly semDesfechoGravado: number;
}

type Contagem = { -readonly [K in keyof ResumoDoEnvio]: ResumoDoEnvio[K] };

function contar(contagem: Contagem, status: string | null): void {
  if (status === 'sent') contagem.enviados++;
  else if (status === 'dead_letter') contagem.recusados++;
  else if (status === 'failed_transient') contagem.repetiveis++;
  else if (status === 'unknown') contagem.desconhecidos++;
  else contagem.semPosse++;
}

function mensagemDoRecibo(resultado: ChatwootApiResult<ChatwootMessage>): MensagemDoRecibo | null {
  if (resultado._tag !== 'ChatwootSuccess') return null;
  const { sender, created_at: criadaEm } = resultado.data;
  return {
    remetenteNome: sender?.name ?? null,
    remetenteId: sender?.id ?? null,
    remetenteTipo: sender?.type ?? null,
    criadaEm: criadaEm ?? null,
  };
}

async function despachar(
  porta: PortaDoConsumidorEnvio,
  workerId: string,
  envio: EnvioReivindicado,
  contagem: Contagem,
): Promise<void> {
  const posse = { eventoId: envio.eventoId, workerId, fencingToken: envio.fencingToken };

  let resolucao: ResolucaoDoCanal;
  try {
    resolucao = await porta.resolverCanal(envio);
  } catch {
    // Nada saiu: a falha foi ao ler vínculo ou credencial, antes da rede.
    contar(contagem, await porta.concluir(posse, {
      _tag: 'NaoEnviado', prova: 'transporte_nao_iniciado', erro: 'Canal do Chatwoot indisponível antes do despacho.',
    }, null));
    return;
  }
  if (resolucao._tag !== 'Canal') {
    const semVinculo = resolucao._tag === 'SemVinculo';
    contar(contagem, await porta.concluir(posse, {
      _tag: 'Recusado',
      categoria: 'permanent',
      codigo: semVinculo ? 'autor_sem_vinculo' : 'nao_configurado',
      erro: semVinculo ? 'Quem pediu o envio não pertence mais à organização.' : 'Chatwoot não configurado para esta conexão.',
    }, null));
    return;
  }

  const inicio = await porta.iniciarDespacho(posse);
  if (inicio === 'aguardando_ai_first') {
    logger.info('chatwoot.envio.aguardando_ai_first', { subsystem: 'queue', eventoId: posse.eventoId });
    contagem.semPosse++;
    return;
  }
  if (inicio === 'invalidado') {
    contagem.invalidados++;
    return;
  }
  if (inicio !== 'iniciado') {
    contagem.semPosse++;
    return;
  }

  let desfecho: DesfechoDoDespacho;
  let mensagem: MensagemDoRecibo | null = null;
  try {
    const resultado = envio.privada
      ? await resolucao.canal.sendPrivateNote(envio.conversaIdExterno, envio.conteudo)
      : await resolucao.canal.sendMessage(envio.conversaIdExterno, envio.conteudo);
    desfecho = validarDesfecho(envio.privada && resultado._tag === 'ChatwootSuccess' && resultado.data.private !== true
      // Algo foi criado e o recibo não prova que é privado: só uma pessoa decide.
      ? { _tag: 'Desconhecido', motivo: 'resposta_invalida', erro: 'Recibo da nota sem a marca de nota privada.' }
      : desfechoDoEnvioChatwoot(resultado));
    mensagem = mensagemDoRecibo(resultado);
  } catch {
    desfecho = desfechoDeFalhaAposDespacho();
  }

  try {
    contar(contagem, await porta.concluir(posse, desfecho, desfecho._tag === 'Confirmado' ? mensagem : null));
  } catch {
    // O efeito pode ter acontecido e o banco não ouviu: `in_flight` vence e o
    // reaper grava `unknown`. Repetir aqui seria o retry inseguro.
    contagem.semDesfechoGravado++;
  }
}

/**
 * Uma passada: reaper, claim e despacho em série. `deveParar` é lido entre
 * envios; o envio em curso termina.
 */
export async function consumirEnviosUmaVez(
  porta: PortaDoConsumidorEnvio,
  opcoes: {
    readonly workerId: string;
    readonly limite: number;
    readonly leaseSegundos: number;
    readonly criadosDesde: string;
    readonly deveParar?: () => boolean;
  },
): Promise<ResumoDoEnvio> {
  const reaped = await porta.liberarLeasesVencidas();
  const lote = await porta.reivindicar(opcoes);
  const contagem: Contagem = {
    reaped, reivindicados: lote.length, enviados: 0, recusados: 0, repetiveis: 0, desconhecidos: 0, invalidados: 0, semPosse: 0, semDesfechoGravado: 0,
  };
  for (const envio of lote) {
    if (opcoes.deveParar?.()) break;
    await despachar(porta, opcoes.workerId, envio, contagem);
  }
  return contagem;
}
