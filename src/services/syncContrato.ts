import type { SyncJob } from '../repositories/syncJobRepository';

/**
 * Contrato observável da sincronização durável.
 *
 * Vive fora de `sync.ts` porque quem consome estes tipos — as rotas — não deve
 * precisar importar o serviço inteiro, e porque `sync.ts` passou do teto de
 * tamanho do portão de slop quando ganhou a distinção de resultado da tentativa
 * de processamento (Ticket 22).
 */

export interface EnqueueSyncResult {
  jobId: string;
  status: string;
  isNew: boolean;
}

/**
 * O que aconteceu com **a tentativa de processar**, que não é a mesma coisa que
 * o estado do job.
 *
 * O estado do registro não responde por si. `queued` não prova que outro worker
 * pegou o trabalho: pode ser que ninguém tenha conseguido nem tentar. E
 * `running` não prova que alguém está tocando: pode ser um worker que já
 * desistiu e não conseguiu gravar o desfecho. As duas leituras viraram sucesso
 * falso no `/api/startup`, uma depois da outra.
 */
export type SyncProcessOutcome =
  /** Rodou até o fim, e o desfecho — sucesso ou falha — está gravado. */
  | { readonly _tag: 'JobFinished' }
  /** Não deu para nem tentar: o registro segue como estava. */
  | { readonly _tag: 'PreparationFailed' }
  /** Outro processo detém a lease. */
  | { readonly _tag: 'LeaseHeldElsewhere' }
  /**
   * Processou, falhou, e **não foi possível gravar estado terminal nenhum**.
   * O registro fica `running` sem ninguém trabalhando nele — então o estado é
   * mentira, e quem chama não pode inferir nada a partir dele.
   */
  | { readonly _tag: 'FinalizationFailed' };

export interface SyncAllResult {
  success: boolean;
  /**
   * Estado terminal observado do job. Existe para o chamador distinguir
   * "falhou" de "já estava rodando" — as duas devolviam `success: false`, e o
   * `/api/startup` anunciava sucesso nas duas.
   */
  status: SyncJob['status'] | 'unknown' | 'preparation_failed' | 'finalization_failed';
  stats: {
    clientes: number;
    produtos: number;
    pedidos: number;
  };
}

/**
 * Diagnóstico público e estável gravado em `sync_jobs.last_error`.
 *
 * Aquele campo sai pela resposta de `GET /api/sync/status`. Antes ele guardava
 * `descreverErro(err)` com uma redação por padrão que só cobria `Bearer …` e
 * `key=…` — então nome de constraint, `details`, `hint` e valor de linha
 * (`Key (email)=(alguem@empresa.com) already exists`) chegavam ao cliente.
 * O diagnóstico técnico vive no log; aqui fica um código fixo (CWE-209).
 */
export const FALHA_PUBLICA_DE_SINCRONIZACAO = 'SYNC_FAILED';

/**
 * Sincronização durável, escopada por uma organização **já verificada**.
 *
 * Ticket 22 — o serviço resolvia o escopo sozinho, a partir de um `ActorContext`
 * cujo `tenant` vinha de `app_metadata`, e traduzia a negação em exceção
 * (`SyncScopeDeniedError`) para a rota transformar em status. Eram duas
 * autorizações para a mesma pergunta, e a de baixo lia a fonte errada.
 *
 * Agora a autorização acontece uma vez só, na fronteira HTTP, que já sabe
 * responder 401/403/503. O serviço recebe o escopo pronto e não decide mais
 * quem pode o quê.
 */
