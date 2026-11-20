import { bling } from './bling';
import type { BlingPort } from './blingPort';
import { espelhoDaPagina } from './espelhoDaImagemDoBling';
import { jobConcluidoComSaude } from './saudeDoBlingPeloSync';
import { clienteRepository } from '../repositories/clienteRepository';
import { produtoRepository } from '../repositories/produtoRepository';
import { situacaoLocalDaSituacaoBling } from '../lib/config/produtoContract';
import { pedidoRepository } from '../repositories/pedidoRepository';
import { Cliente, Produto, Pedido, ItemPedido } from '../types';
import { descreverErro } from '../lib/erroLegivel';
import { registrarFalhaInterna } from '../lib/observability/falhaInterna';
import { mapBlingStatus, normalizeToE164 } from '../lib/utils';
import type { VerifiedOrganizationScope } from '../lib/verifiedOrganizationScope';
import {
  FALHA_PUBLICA_DE_SINCRONIZACAO,
  type EnqueueSyncResult,
  type SyncAllResult,
  type SyncProcessOutcome,
} from './syncContrato';

export {
  FALHA_PUBLICA_DE_SINCRONIZACAO,
  type EnqueueSyncResult,
  type SyncAllResult,
  type SyncProcessOutcome,
};
import {
  enqueueJob,
  acquireLease,
  advanceCheckpoint,
  completeJob,
  getJobStatus,
  releaseExpiredLeases,
  type SyncJobProgress,
  type SyncJob,
} from '../repositories/syncJobRepository';

import {
  getBlingDateTime,
  getLastSyncedAt,
  syncPaginatedEntities,
  touchSyncState,
} from './syncCheckpoint';

/**
 * Sincronização Bling → ORBITA de clientes, produtos e pedidos de uma organização.
 *
 * ENTRA AQUI POR: `after()` em `app/api/sync/route.ts`, depois de a resposta
 * `202` já ter saído (`POST /api/startup` usa `syncAll`, dentro da requisição). O estado
 * do job fica em `syncJobRepository.ts`; o marcador incremental por entidade,
 * em `syncCheckpoint.ts`.
 *
 * Fluxo: `enqueueJob` cria o job → `processJob` adquire a lease → etapas
 * `clientes → produtos → pedidos`, gravando progresso após cada uma →
 * `completeJob`. Produtos e pedidos usam leitura incremental por
 * `dataAlteracaoInicial` (checkpoint em `syncCheckpoint.ts`); gravações locais
 * são upserts, então reexecutar uma etapa atualiza em vez de duplicar.
 *
 * A lease reduz execuções concorrentes do mesmo job, mas a conclusão
 * (`concluir_job_sync`) não confere dono da lease — os comentários abaixo
 * explicam os casos ambíguos que ficam sem decisão automática.
 */
export class SyncService {
  async enqueueSync(scope: VerifiedOrganizationScope): Promise<EnqueueSyncResult> {
    return enqueueJob(scope);
  }

  /**
   * Processa o job. Com `completa: true`, ignora o checkpoint de
   * `dataAlteracaoInicial` e relê tudo do Bling.
   *
   * A opção é a saída para um checkpoint incorreto: se o marcador avançou
   * sem que os dados daquele intervalo tenham sido lidos, a consulta
   * incremental nunca mais os devolveria.
   *
   * Concorrência: antes das etapas, libera leases vencidas e tenta adquirir a
   * lease do job. Sem lease, outra execução está com ele (`LeaseHeldElsewhere`).
   */
  async processJob(
    jobId: string,
    scope: VerifiedOrganizationScope,
    opcoes: { completa?: boolean } = {},
  ): Promise<SyncProcessOutcome> {
    // A preparação fica dentro de `try`. Em `POST /api/sync` este método roda
    // dentro de `after()`, depois da resposta 202 já ter saído: uma rejeição
    // aqui seria promise não observada, sem nenhum registro da falha.
    let leaseAcquired: boolean;
    try {
      await releaseExpiredLeases();
      leaseAcquired = await acquireLease(scope, jobId);
    } catch (err: unknown) {
      registrarFalhaInterna('sync.preparar', err, {
        organizacaoId: scope.organizationId,
        atorId: scope.actorId,
      });
      // **Não** encerra o job aqui, e isto é deliberado. Uma rejeição de
      // `acquireLease` é resultado *ambíguo*: a RPC pode ter concedido a lease
      // e a resposta ter se perdido, e pode haver outra callback processando
      // este mesmo job agora. `concluir_job_sync` atualiza incondicionalmente
      // por id e limpa a lease — então marcar falho aqui derrubaria o job que
      // outra execução está tocando, liberaria a restrição de job ativo e
      // abriria caminho para duas sincronizações concorrentes.
      //
      // Encerrar com segurança exigiria identidade de lease (`lease_owner`) e
      // compare-and-set no banco, o que é migration própria. Sem isso, quem
      // decide é a próxima execução. O job fica `queued`, que é verdade, em vez
      // de `failed`, que seria mentira sobre um trabalho possivelmente em
      // andamento.
      //
      // **O TTL não cobre este caso.** Ele só resolve quando a aquisição foi
      // confirmada remotamente e a resposta se perdeu: aí existe uma lease para
      // expirar, e `releaseExpiredLeases` a libera. Se a RPC falhou **antes** de
      // conceder, não há lease nenhuma, e o job permanece `queued` até que
      // alguém chame de novo.
      return { _tag: 'PreparationFailed' };
    }

    if (!leaseAcquired) return { _tag: 'LeaseHeldElsewhere' };

    const progress: SyncJobProgress = {
      clientes_processados: 0,
      produtos_processados: 0,
      pedidos_processados: 0,
      etapa_atual: 'clientes',
      pagina_atual: 1,
    };

    try {
      const blingClient = bling.forVerifiedOrganization(scope);

      const steps: Array<{
        etapa: 'clientes' | 'produtos' | 'pedidos';
        proxima: 'produtos' | 'pedidos' | 'concluido';
        field: 'clientes_processados' | 'produtos_processados' | 'pedidos_processados';
        action: () => Promise<number>;
      }> = [
        {
          etapa: 'clientes',
          proxima: 'produtos',
          field: 'clientes_processados',
          action: () => this._syncClientes(scope, jobId, blingClient, progress),
        },
        {
          etapa: 'produtos',
          proxima: 'pedidos',
          field: 'produtos_processados',
          action: () => this._syncProdutos(scope, jobId, blingClient, progress, opcoes.completa === true),
        },
        {
          etapa: 'pedidos',
          proxima: 'concluido',
          field: 'pedidos_processados',
          action: () => this._syncPedidos(scope, jobId, blingClient, progress, opcoes.completa === true),
        },
      ];

      for (const step of steps) {
        progress.etapa_atual = step.etapa;
        const count = await step.action();
        progress[step.field] = count;
        progress.etapa_atual = step.proxima;
        progress.pagina_atual = 1;
        await advanceCheckpoint(scope, jobId, { ...progress });
      }

    } catch (err: unknown) {
      registrarFalhaInterna('sync.processar', err, {
        organizacaoId: scope.organizationId,
        atorId: scope.actorId,
      });
      try {
        await completeJob(scope, jobId, 'failed', FALHA_PUBLICA_DE_SINCRONIZACAO);
      } catch (erroAoConcluir: unknown) {
        registrarFalhaInterna('sync.concluir_apos_falha', erroAoConcluir, {
          organizacaoId: scope.organizationId,
        });
        // Nem o estado terminal foi gravado. O registro fica `running` sem
        // ninguém trabalhando nele — dizer `JobFinished` aqui faria o chamador
        // ler esse `running` como "alguém está tocando" e anunciar sucesso.
        return { _tag: 'FinalizationFailed' };
      }
      return jobConcluidoComSaude(scope, 'error');
    }

    // A conclusão como `completed` fica **fora** do bloco das etapas. Dentro
    // dele, uma resposta perdida depois de a RPC ter concluído o job cairia no
    // `catch` e chamaria `completeJob(..., 'failed')`; como `concluir_job_sync`
    // atualiza incondicionalmente por id, isso sobrescreveria `completed`.
    try {
      await completeJob(scope, jobId, 'completed');
    } catch (erroAoConcluir: unknown) {
      registrarFalhaInterna('sync.concluir_como_completo', erroAoConcluir, {
        organizacaoId: scope.organizationId,
      });
      // Resultado **ambíguo**: não sabemos se `completed` foi aplicado do outro
      // lado. Tentar gravar `failed` aqui seria justamente a sobrescrita
      // destrutiva. O trabalho terminou; o que não dá para afirmar é o registro.
      return { _tag: 'FinalizationFailed' };
    }

    return jobConcluidoComSaude(scope, 'healthy');
  }

  async getJobStatus(jobId: string, scope: VerifiedOrganizationScope): Promise<SyncJob | null> {
    return getJobStatus(scope, jobId);
  }

  async syncAll(scope: VerifiedOrganizationScope): Promise<SyncAllResult> {
    const { jobId } = await this.enqueueSync(scope);
    const outcome = await this.processJob(jobId, scope);

    // A tentativa de processar tem resposta própria. Nestes dois ramos o estado
    // gravado **não** descreve a realidade — `queued` sem ninguém tentando, ou
    // `running` de um worker que já desistiu — então ele não é consultado.
    if (outcome._tag === 'PreparationFailed' || outcome._tag === 'FinalizationFailed') {
      return {
        success: false,
        status: outcome._tag === 'PreparationFailed' ? 'preparation_failed' : 'finalization_failed',
        stats: { clientes: 0, produtos: 0, pedidos: 0 },
      };
    }

    const status = await this.getJobStatus(jobId, scope);

    return {
      success: status?.status === 'completed',
      status: status?.status ?? 'unknown',
      stats: {
        clientes: status?.progress.clientes_processados ?? 0,
        produtos: status?.progress.produtos_processados ?? 0,
        pedidos: status?.progress.pedidos_processados ?? 0,
      },
    };
  }

  /**
   * Contatos não usam checkpoint: a etapa relê a lista inteira toda vez, então
   * `completa` não muda nada aqui. Isso importa para o diagnóstico — esta
   * etapa voltar zero com contatos existindo no Bling só pode significar
   * leitura falhando, nunca "nada mudou".
   */
  private async _syncClientes(
    scope: VerifiedOrganizationScope,
    jobId: string,
    blingClient: BlingPort,
    progress: SyncJobProgress,
  ): Promise<number> {
    try {
      const total = await syncPaginatedEntities(
        (page) => blingClient.getClientes(page, 100),
        async (bc) => {
          const tel = bc.telefone || bc.celular || undefined;
          const cliente: Cliente = {
            bling_id: String(bc.id),
            nome: bc.nome,
            cpf_cnpj: bc.cnpj || bc.numeroDocumento || undefined,
            email: bc.email || undefined,
            telefone: tel,
            telefone_normalizado: normalizeToE164(tel) || undefined,
          };
          await clienteRepository.upsert(scope, cliente);
        },
        async (page, count) => {
          progress.pagina_atual = page;
          progress.clientes_processados = count;
          await advanceCheckpoint(scope, jobId, { ...progress });
        },
      );

      await touchSyncState(scope.organizationId, scope.actorId, 'clientes');
      return total;
    } catch (err: unknown) {
      // A etapa NÃO devolve 0 numa falha: o job não pode concluir como
      // sucesso, e o checkpoint (`touchSyncState`) só avança no caminho feliz.
      throw new Error(`Etapa clientes falhou: ${descreverErro(err)}`);
    }
  }

  private async _syncProdutos(
    scope: VerifiedOrganizationScope,
    jobId: string,
    blingClient: BlingPort,
    progress: SyncJobProgress,
    completa = false,
  ): Promise<number> {
    try {
      const lastSynced = completa ? null : await getLastSyncedAt(scope.organizationId, 'produtos');
      const dataAlteracao = getBlingDateTime(lastSynced);

      const total = await syncPaginatedEntities(
        async (page) => {
          const blingProdutos = await blingClient.getProdutos(page, 100, undefined, dataAlteracao);
          if (blingProdutos.length === 0) return [];

          const idsToFetch = blingProdutos.map((p: { id: number | string }) => String(p.id));
          let saldosArray: unknown[] = [];
          for (let i = 0; i < idsToFetch.length; i += 50) {
            const chunk = idsToFetch.slice(i, i + 50);
            const saldosChunk = await blingClient.getEstoquesSaldos(chunk);
            saldosArray = saldosArray.concat(saldosChunk);
          }

          const saldosMap = new Map<string, number>();
          (
            saldosArray as Array<{
              produto?: { id: number | string };
              saldoFisicoTotal?: number;
              saldoFisico?: number;
            }>
          ).forEach((item) => {
            if (item.produto?.id) {
              saldosMap.set(
                String(item.produto.id),
                Number(item.saldoFisicoTotal ?? item.saldoFisico ?? 0),
              );
            }
          });

          const espelharImagem = await espelhoDaPagina(scope, blingClient, idsToFetch);
          return blingProdutos.map((bp) => ({
            raw: bp,
            saldo: saldosMap.get(String(bp.id)) ?? 0,
            espelharImagem,
          }));
        },
        async ({ raw: bp, saldo, espelharImagem }) => {
          await produtoRepository.upsert(scope, {
            bling_id: String(bp.id),
            codigo: bp.codigo || undefined,
            nome: bp.nome,
            preco: Number(bp.preco),
            unidade: bp.unidade || 'UN',
            imagem_url: await espelharImagem(bp),
            estoque: saldo,
            situacao: situacaoLocalDaSituacaoBling((bp as { situacao?: unknown }).situacao), // arquivado fica (migration 75)
          } satisfies Produto);
        },
        async (page, count) => {
          progress.pagina_atual = page;
          progress.produtos_processados = count;
          await advanceCheckpoint(scope, jobId, { ...progress });
        },
      );

      await touchSyncState(scope.organizationId, scope.actorId, 'produtos');
      return total;
    } catch (err: unknown) {
      // A etapa NÃO devolve 0 numa falha: o job não pode concluir como
      // sucesso, e o checkpoint (`touchSyncState`) só avança no caminho feliz.
      throw new Error(`Etapa produtos falhou: ${descreverErro(err)}`);
    }
  }

  private async _syncPedidos(
    scope: VerifiedOrganizationScope,
    jobId: string,
    blingClient: BlingPort,
    progress: SyncJobProgress,
    completa = false,
  ): Promise<number> {
    try {
      const lastSynced = completa ? null : await getLastSyncedAt(scope.organizationId, 'pedidos');
      const dataInicial = lastSynced ? new Date(lastSynced).toISOString().split('T')[0] : undefined;

      const total = await syncPaginatedEntities(
        (page) => blingClient.getPedidos(page, 100, dataInicial),
        async (resumo) => {
          // A LISTA de pedidos não traz itens: no schema oficial, `itens` só
          // existe em `VendasDadosDTO`, do detalhe. Sem esta segunda chamada,
          // `itens_pedido` fica vazio para sempre e faturamento por produto,
          // estoque e NF-e nunca saem de zero.
          const bp = await blingClient.getPedido(String(resumo.id));
          if (!bp) {
            console.warn(`⚠️ sync pedidos: pedido Bling ${resumo.id} sumiu entre a lista e o detalhe.`);
            return;
          }

          const clienteLocal = await clienteRepository.getByBlingId(scope, String(bp.contato.id));
          if (!clienteLocal?.id) {
            console.warn(
              `⚠️ sync pedidos: cliente Bling ID ${bp.contato.id} não encontrado, pedido ${bp.numero} ignorado.`,
            );
            return;
          }

          const statusCanonico = mapBlingStatus(bp.situacao.valor);
          const pedido: Pedido = {
            bling_id: String(bp.id),
            numero: String(bp.numero),
            data: bp.data,
            total: Number(bp.total),
            status: statusCanonico,
            cliente_id: clienteLocal.id,
          };

          const savedPedido = await pedidoRepository.upsert(scope, pedido);

          const itemsParaSalvar: ItemPedido[] = [];
          for (const item of bp.itens ?? []) {
            if (item.produto?.id) {
              const produtoLocal = await produtoRepository.getByBlingId(
                scope,
                String(item.produto.id),
              );
              if (produtoLocal?.id && savedPedido.id) {
                itemsParaSalvar.push({
                  pedido_id: savedPedido.id,
                  produto_id: produtoLocal.id,
                  quantidade: item.quantidade,
                  valor_unitario: Number(item.valor ?? 0),
                });
              }
            }
          }
          if (itemsParaSalvar.length > 0) {
            await pedidoRepository.addItems(scope, itemsParaSalvar);
          }
        },
        async (page, count) => {
          progress.pagina_atual = page;
          progress.pedidos_processados = count;
          await advanceCheckpoint(scope, jobId, { ...progress });
        },
      );

      await touchSyncState(scope.organizationId, scope.actorId, 'pedidos');
      return total;
    } catch (err: unknown) {
      // A etapa NÃO devolve 0 numa falha: o job não pode concluir como
      // sucesso, e o checkpoint (`touchSyncState`) só avança no caminho feliz.
      throw new Error(`Etapa pedidos falhou: ${descreverErro(err)}`);
    }
  }
}

// A autorização acontece antes, na fronteira HTTP, que responde 403 e 503.
// Um erro que sai daqui é falha de sincronização, nunca de permissão.

export const syncService = new SyncService();
