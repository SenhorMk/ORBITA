import { bling, extractBlingImageUrl } from './bling';
import type { BlingPort } from './blingPort';
import { clienteRepository } from '../repositories/clienteRepository';
import { produtoRepository } from '../repositories/produtoRepository';
import { pedidoRepository } from '../repositories/pedidoRepository';
import { Cliente, Produto, Pedido, ItemPedido } from '../types';
import { descreverErro } from '../lib/erroLegivel';
import { supabaseServer } from '../lib/supabaseServer';
import { mapBlingStatus, normalizeToE164 } from '../lib/utils';
import type { ActorContext, VerifiedTenant } from '../lib/auth';
import { verifyOrganizationScope, type VerifiedOrganizationScope } from '../lib/verifiedOrganizationScope';
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

import { resolveTenantOrgId } from '../lib/organizationContext';
// resolveTenantOrgId is used only to resolve the ActorContext's organization
// membership when constructing the VerifiedOrganizationScope in
// resolveScope() below. Every DB read/write in this service uses the
// resulting verified scope (scope.organizationId), never the primitive
// tenant/user id as authority.

import {
  getBlingDateTime,
  getLastSyncedAt,
  syncPaginatedEntities,
  touchSyncState,
} from './syncCheckpoint';

export interface EnqueueSyncResult {
  jobId: string;
  status: string;
  isNew: boolean;
}

export interface SyncAllResult {
  success: boolean;
  stats: {
    clientes: number;
    produtos: number;
    pedidos: number;
  };
}

export class SyncService {
  private async resolveScope(context: ActorContext): Promise<VerifiedOrganizationScope> {
    const organizationId = await resolveTenantOrgId(supabaseServer, context.tenant);
    const result = await verifyOrganizationScope(supabaseServer, {
      organizationId,
      actorId: context.actorId,
    });
    if (result._tag === 'OrganizationScopeDenied') {
      throw new SyncScopeDeniedError();
    }
    if (result._tag === 'OrganizationScopeStoreUnavailable') {
      throw new SyncAuthorizationStoreUnavailableError();
    }
    return result.scope;
  }

  async enqueueSync(context: ActorContext): Promise<EnqueueSyncResult> {
    return enqueueJob(await this.resolveScope(context));
  }

  /**
   * Processa o job. Com `completa: true`, ignora o checkpoint de
   * `dataAlteracaoInicial` e relê tudo do Bling.
   *
   * A opção existe porque o checkpoint podia ser envenenado: uma leitura que
   * falhava devolvia `[]`, a etapa "concluía" com zero itens e
   * `touchSyncState` avançava o marcador mesmo assim. Da vez seguinte o Bling
   * era consultado por "alterados desde o momento da falha" e respondia zero —
   * corretamente. Sem uma sincronização completa não havia como sair disso.
   */
  async processJob(jobId: string, context: ActorContext, opcoes: { completa?: boolean } = {}): Promise<void> {
    let scope: VerifiedOrganizationScope;
    try {
      scope = await this.resolveScope(context);
    } catch (error: unknown) {
      if (error instanceof SyncScopeDeniedError || error instanceof SyncAuthorizationStoreUnavailableError) {
        console.error('Sincronização não iniciada: escopo organizacional indisponível ou revogado.');
        return;
      }
      throw error;
    }
    const tenant = context.tenant;
    await releaseExpiredLeases();

    const leaseAcquired = await acquireLease(scope, jobId);
    if (!leaseAcquired) {
      return;
    }

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
          action: () => this._syncClientes(scope, jobId, tenant, blingClient, progress),
        },
        {
          etapa: 'produtos',
          proxima: 'pedidos',
          field: 'produtos_processados',
          action: () => this._syncProdutos(scope, jobId, tenant, blingClient, progress, opcoes.completa === true),
        },
        {
          etapa: 'pedidos',
          proxima: 'concluido',
          field: 'pedidos_processados',
          action: () => this._syncPedidos(scope, jobId, tenant, blingClient, progress, opcoes.completa === true),
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

      await completeJob(scope, jobId, 'completed');
    } catch (err: unknown) {
      const msg = descreverErro(err);
      const redacted = msg
        .replace(/Bearer\s+\S+/gi, '[REDACTED]')
        .replace(/key=[^&\s]*/gi, 'key=[REDACTED]');
      console.error('❌ Sincronização Orbita: Job falhou.', { jobId, error: redacted });
      await completeJob(scope, jobId, 'failed', redacted);
    }
  }

  async getJobStatus(jobId: string, context: ActorContext): Promise<SyncJob | null> {
    return getJobStatus(await this.resolveScope(context), jobId);
  }

  async syncAll(context: ActorContext): Promise<SyncAllResult> {
    const { jobId } = await this.enqueueSync(context);
    await this.processJob(jobId, context);
    const status = await this.getJobStatus(jobId, context);

    return {
      success: status?.status === 'completed',
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
    tenant: VerifiedTenant,
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

      await touchSyncState(scope.organizationId, tenant.id, 'clientes');
      return total;
    } catch (err: unknown) {
      // A etapa NAO devolve 0 numa falha. Devolver zero fazia o job
      // concluir como sucesso, e — pior — o checkpoint ja tinha avancado,
      // entao as execucoes seguintes filtravam por `dataAlteracaoInicial`
      // a partir do momento da falha e nunca mais viam nada.
      throw new Error(`Etapa clientes falhou: ${descreverErro(err)}`);
    }
  }

  private async _syncProdutos(
    scope: VerifiedOrganizationScope,
    jobId: string,
    tenant: VerifiedTenant,
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

          return blingProdutos.map((bp) => ({
            raw: bp,
            saldo: saldosMap.get(String(bp.id)) ?? 0,
          }));
        },
        async ({ raw: bp, saldo }) => {
          const imgUrl = extractBlingImageUrl(bp);
          const produto: Produto = {
            bling_id: String(bp.id),
            codigo: bp.codigo || undefined,
            nome: bp.nome,
            preco: Number(bp.preco),
            unidade: bp.unidade || 'UN',
            imagem_url: imgUrl,
            estoque: saldo,
          };
          await produtoRepository.upsert(scope, produto);
        },
        async (page, count) => {
          progress.pagina_atual = page;
          progress.produtos_processados = count;
          await advanceCheckpoint(scope, jobId, { ...progress });
        },
      );

      await touchSyncState(scope.organizationId, tenant.id, 'produtos');
      return total;
    } catch (err: unknown) {
      // A etapa NAO devolve 0 numa falha. Devolver zero fazia o job
      // concluir como sucesso, e — pior — o checkpoint ja tinha avancado,
      // entao as execucoes seguintes filtravam por `dataAlteracaoInicial`
      // a partir do momento da falha e nunca mais viam nada.
      throw new Error(`Etapa produtos falhou: ${descreverErro(err)}`);
    }
  }

  private async _syncPedidos(
    scope: VerifiedOrganizationScope,
    jobId: string,
    tenant: VerifiedTenant,
    blingClient: BlingPort,
    progress: SyncJobProgress,
    completa = false,
  ): Promise<number> {
    try {
      const lastSynced = completa ? null : await getLastSyncedAt(scope.organizationId, 'pedidos');
      const dataInicial = lastSynced ? new Date(lastSynced).toISOString().split('T')[0] : undefined;

      const total = await syncPaginatedEntities(
        (page) => blingClient.getPedidos(page, 100, dataInicial),
        async (bp) => {
          const clienteLocal = await clienteRepository.getByBlingId(scope, bp.contato.id);
          if (!clienteLocal?.id) {
            console.warn(
              `⚠️ sync pedidos: cliente Bling ID ${bp.contato.id} não encontrado, pedido ${bp.numero} ignorado.`,
            );
            return;
          }

          const statusCanonico = mapBlingStatus(bp.situacao.valor);
          const pedido: Pedido = {
            bling_id: bp.id,
            numero: bp.numero,
            data: bp.data,
            total: Number(bp.total),
            status: statusCanonico,
            cliente_id: clienteLocal.id,
          };

          const savedPedido = await pedidoRepository.upsert(scope, pedido);

          const itemsParaSalvar: ItemPedido[] = [];
          for (const item of bp.itens) {
            if (item.produto?.id) {
              const produtoLocal = await produtoRepository.getByBlingId(
                scope,
                item.produto.id,
              );
              if (produtoLocal?.id && savedPedido.id) {
                itemsParaSalvar.push({
                  pedido_id: savedPedido.id,
                  produto_id: produtoLocal.id,
                  quantidade: item.quantidade,
                  valor_unitario: Number(item.valorunitario ?? item.valor ?? 0),
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

      await touchSyncState(scope.organizationId, tenant.id, 'pedidos');
      return total;
    } catch (err: unknown) {
      // A etapa NAO devolve 0 numa falha. Devolver zero fazia o job
      // concluir como sucesso, e — pior — o checkpoint ja tinha avancado,
      // entao as execucoes seguintes filtravam por `dataAlteracaoInicial`
      // a partir do momento da falha e nunca mais viam nada.
      throw new Error(`Etapa pedidos falhou: ${descreverErro(err)}`);
    }
  }
}

export class SyncScopeDeniedError extends Error {
  readonly _tag = 'SyncScopeDeniedError';
  constructor() {
    super('Escopo organizacional não verificado.');
    this.name = 'SyncScopeDeniedError';
  }
}

export class SyncAuthorizationStoreUnavailableError extends Error {
  readonly _tag = 'SyncAuthorizationStoreUnavailableError';
  constructor() {
    super('Serviço de autorização temporariamente indisponível.');
    this.name = 'SyncAuthorizationStoreUnavailableError';
  }
}

export const syncService = new SyncService();
