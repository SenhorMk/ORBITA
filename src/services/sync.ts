import { bling, extractBlingImageUrl } from './bling';
import type { BlingPort } from './blingPort';
import { clienteRepository } from '../repositories/clienteRepository';
import { produtoRepository } from '../repositories/produtoRepository';
import { pedidoRepository } from '../repositories/pedidoRepository';
import { Cliente, Produto, Pedido, ItemPedido } from '../types';
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

async function getLastSyncedAt(orgId: string, entidade: string): Promise<string | null> {
  const { data } = await supabaseServer
    .from('sync_state')
    .select('last_synced_at')
    .eq('entidade', entidade)
    .eq('organizacao_id', orgId)
    .maybeSingle();
  return data?.last_synced_at ?? null;
}

async function touchSyncState(orgId: string, userId: string, entidade: string): Promise<void> {
  const now = new Date().toISOString();
  await supabaseServer
    .from('sync_state')
    .upsert(
      {
        organizacao_id: orgId,
        user_id: userId,
        entidade,
        last_synced_at: now,
        updated_at: now,
      },
      { onConflict: 'organizacao_id, entidade' },
    );
}

function getBlingDateTime(isoString?: string | null): string | undefined {
  if (!isoString) return undefined;
  const d = new Date(isoString);
  const formatter = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(d);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

async function syncPaginatedEntities<T>(
  fetchPage: (page: number) => Promise<T[]>,
  processItem: (item: T) => Promise<void>,
  onPageDone: (page: number, count: number) => Promise<void>,
): Promise<number> {
  let total = 0;
  let page = 1;
  while (true) {
    const items = await fetchPage(page);
    if (items.length === 0) break;

    for (const item of items) {
      try {
        await processItem(item);
        total++;
      } catch (itemErr: unknown) {
        const msg = itemErr instanceof Error ? itemErr.message : String(itemErr);
        console.warn(`⚠️ sync item error: ${msg}`);
      }
    }

    await onPageDone(page, total);
    page++;
    if (items.length < 100) break;
  }
  return total;
}

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

  async processJob(jobId: string, context: ActorContext): Promise<void> {
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
          action: () => this._syncProdutos(scope, jobId, tenant, blingClient, progress),
        },
        {
          etapa: 'pedidos',
          proxima: 'concluido',
          field: 'pedidos_processados',
          action: () => this._syncPedidos(scope, jobId, tenant, blingClient, progress),
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
      const msg = err instanceof Error ? err.message : String(err);
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
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('⚠️ Etapa clientes falhou:', msg);
      return 0;
    }
  }

  private async _syncProdutos(
    scope: VerifiedOrganizationScope,
    jobId: string,
    tenant: VerifiedTenant,
    blingClient: BlingPort,
    progress: SyncJobProgress,
  ): Promise<number> {
    try {
      const lastSynced = await getLastSyncedAt(scope.organizationId, 'produtos');
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
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('⚠️ Etapa produtos falhou:', msg);
      return 0;
    }
  }

  private async _syncPedidos(
    scope: VerifiedOrganizationScope,
    jobId: string,
    tenant: VerifiedTenant,
    blingClient: BlingPort,
    progress: SyncJobProgress,
  ): Promise<number> {
    try {
      const lastSynced = await getLastSyncedAt(scope.organizationId, 'pedidos');
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
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('⚠️ Etapa pedidos falhou:', msg);
      return 0;
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
