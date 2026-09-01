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
 * `queued` não prova que outro worker pegou o trabalho: pode ser que ninguém
 * tenha conseguido nem tentar. Sem esta distinção, o `/api/startup` lia `queued`
 * e anunciava "já está rodando" — sucesso falso, e derivado justamente da
 * correção que deixou de encerrar o job em falha ambígua.
 */
export type SyncProcessOutcome =
  | { readonly _tag: 'JobFinished' }
  | { readonly _tag: 'PreparationFailed' }
  | { readonly _tag: 'LeaseHeldElsewhere' };

export interface SyncAllResult {
  success: boolean;
  /**
   * Estado terminal observado do job. Existe para o chamador distinguir
   * "falhou" de "já estava rodando" — as duas devolviam `success: false`, e o
   * `/api/startup` anunciava sucesso nas duas.
   */
  status: SyncJob['status'] | 'unknown' | 'preparation_failed';
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
