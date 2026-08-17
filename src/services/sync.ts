import { bling, extractBlingImageUrl } from './bling';
import { clienteRepository } from '../repositories/clienteRepository';
import { produtoRepository } from '../repositories/produtoRepository';
import { pedidoRepository } from '../repositories/pedidoRepository';
import { Cliente, Produto, Pedido, ItemPedido } from '../types';
import { supabaseServer } from '../lib/supabaseServer';
import { mapBlingStatus, normalizeToE164 } from '../lib/utils';

export class SyncService {
  private isSyncing = false;

  async syncAll(userId: string): Promise<{ success: boolean; stats: { clientes: number; produtos: number; pedidos: number } }> {
    if (this.isSyncing) {
      throw new Error('Uma sincronização de dados já está em execução neste processo.');
    }

    let dbLocked = false;

    // 0. Trava de concorrência pg_advisory_lock via RPC no banco
    try {
      const { data: lockAcquired, error: lockError } = await supabaseServer.rpc('try_advisory_lock_sync', { p_user_id: userId });
      if (lockError) {
        console.warn('⚠️ Alerta: Função RPC de lock não disponível, prosseguindo com trava local:', lockError.message);
      } else if (lockAcquired === false) {
        throw new Error('Uma sincronização de dados já está em execução (lock distribuído ativo no banco).');
      } else if (lockAcquired === true) {
        dbLocked = true;
      }
    } catch (err: any) {
      if (err.message.includes('lock distribuído')) {
        throw err;
      }
      console.warn('⚠️ Alerta: Não foi possível obter lock distribuído, prosseguindo com trava local:', err.message);
    }

    this.isSyncing = true;
    console.log('🔄 Sincronização Orbita: Iniciando ETL incremental da API Bling...');

    const stats = {
      clientes: 0,
      produtos: 0,
      pedidos: 0,
    };

    const blingClient = userId ? bling.forUser(userId) : bling;

    try {
      // 0. Sincronizar Categorias
      try {
        let page = 1;
        while (true) {
          const categorias = await blingClient.getCategoriasProdutos(page, 100);
          if (categorias.length === 0) break;
          console.log(`🔄 Sincronização: Processando página ${page} de categorias do Bling...`);

          const upsertPromises = categorias.map(async (cat) => {
            const payload = {
              bling_id: String(cat.id),
              user_id: userId,
              descricao: cat.descricao,
              categoria_pai_id: cat.categoriaPai?.id ? String(cat.categoriaPai.id) : null,
            };
            return supabaseServer.from('categorias').upsert(payload, { onConflict: 'user_id, bling_id' });
          });
          await Promise.all(upsertPromises);
          
          page++;
          if (categorias.length < 100) break;
        }
      } catch (err: any) {
        console.warn('⚠️ Sincronização Categorias:', err.message);
      }

      // Função auxiliar para converter ISO string para YYYY-MM-DD HH:mm:ss no fuso de Brasília
      const getBlingDateTime = (isoString?: string | null) => {
        if (!isoString) return undefined;
        const d = new Date(isoString);
        
        const formatter = new Intl.DateTimeFormat('pt-BR', {
          timeZone: 'America/Sao_Paulo',
          year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', second: '2-digit',
          hour12: false
        });
        
        const parts = formatter.formatToParts(d);
        const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
        
        return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
      };

      // 1. Sincronizar Clientes (Contatos no Bling)
      try {
        let lastSyncedAt: string | null = null;
        const { data: state } = await supabaseServer.from('sync_state').select('last_synced_at').eq('entidade', 'clientes').eq('user_id', userId).maybeSingle();
        let page = 1;
        while (true) {
          const blingClientes = await blingClient.getClientes(page, 100);

          if (blingClientes.length === 0) break;
          console.log(`🔄 Sincronização: Processando página ${page} de contatos do Bling...`);
          
          for (const bc of blingClientes) {
            try {
              const tel = bc.telefone || bc.celular || undefined;
              const cliente: Cliente = {
                bling_id: String(bc.id),
                nome: bc.nome,
                cpf_cnpj: bc.cnpj || bc.numeroDocumento || undefined,
                email: bc.email || undefined,
                telefone: tel,
                telefone_normalizado: normalizeToE164(tel) || undefined,
              };
              await clienteRepository.upsert(userId, cliente);
              stats.clientes++;
            } catch (itemErr: any) {
              console.warn(`⚠️ Erro ao salvar cliente Bling ID ${bc.id} no Supabase: ${itemErr.message}`);
            }
          }
          page++;
          if (blingClientes.length < 100) break;
        }
        await supabaseServer.from('sync_state').upsert({ user_id: userId, entidade: 'clientes', last_synced_at: new Date().toISOString(), updated_at: new Date().toISOString() }, { onConflict: 'user_id, entidade' });
      } catch (err: any) {
        console.warn('⚠️ Sincronização Clientes (via Pedidos):', err.message);
      }

      // Remoção do passo 1.5 (Full sync contatos) devido a arquitetura de Strict Schema Mirroring e Push Síncrono

      // 2. Sincronizar Produtos (Pull do Bling -> Supabase)
      try {
        let lastSyncedAt: string | null = null;
        const { data: state } = await supabaseServer.from('sync_state').select('last_synced_at').eq('entidade', 'produtos').eq('user_id', userId).maybeSingle();
        if (state?.last_synced_at) lastSyncedAt = state.last_synced_at;
        const dataAlteracao = getBlingDateTime(lastSyncedAt);

        let page = 1;
        while (true) {
          const blingProdutos = await blingClient.getProdutos(page, 100, undefined, dataAlteracao);
          if (blingProdutos.length === 0) break;
          console.log(`🔄 Sincronização: Processando página ${page} de produtos do Bling...`);
          
          // Buscar saldos físicos reais em lote (Bling API v3 limita a 50 ids por requisição em estoques/saldos)
          const idsToFetch = blingProdutos.map((p: any) => String(p.id));
          let saldosArray: any[] = [];
          for (let i = 0; i < idsToFetch.length; i += 50) {
            const chunk = idsToFetch.slice(i, i + 50);
            const saldosChunk = await blingClient.getEstoquesSaldos(chunk);
            saldosArray = saldosArray.concat(saldosChunk);
          }

          const saldosMap = new Map();
          saldosArray.forEach((item: any) => {
            if (item.produto?.id) {
              saldosMap.set(String(item.produto.id), Number(item.saldoFisicoTotal ?? item.saldoFisico ?? 0));
            }
          });
          
          for (const bp of blingProdutos) {
            try {
              const imgUrl = extractBlingImageUrl(bp);
              const saldoFisico = saldosMap.get(String(bp.id)) ?? 0;
              
              const produto: Produto = {
                bling_id: String(bp.id),
                codigo: bp.codigo || undefined,
                nome: bp.nome,
                preco: Number(bp.preco),
                unidade: bp.unidade || 'UN',
                imagem_url: imgUrl,
                estoque: saldoFisico,
              };
              await produtoRepository.upsert(userId, produto);
              stats.produtos++;
            } catch (itemErr: any) {
              console.warn(`⚠️ Erro ao salvar produto Bling ID ${bp.id} no Supabase: ${itemErr.message}`);
            }
          }
          page++;
          if (blingProdutos.length < 100) break;
        }
        await supabaseServer.from('sync_state').upsert({ user_id: userId, entidade: 'produtos', last_synced_at: new Date().toISOString(), updated_at: new Date().toISOString() }, { onConflict: 'user_id, entidade' });
      } catch (err: any) {
        console.warn('⚠️ Sincronização Produtos (Pull):', err.message);
      }

      // Reconciliações (2.1 Produtos e 1.1 Clientes) foram removidas da rotina de batch sync.
      // A arquitetura foi alterada para Push Unitário Síncrono garantido pelo Strict Schema Mirroring.

      // 3. Sincronizar Pedidos e seus itens relacionais
      try {
        let lastSyncedAt: string | null = null;
        const { data: state } = await supabaseServer
          .from('sync_state')
          .select('last_synced_at')
          .eq('entidade', 'pedidos')
          .eq('user_id', userId)
          .maybeSingle();

        if (state?.last_synced_at) {
          lastSyncedAt = state.last_synced_at;
        }

        const dataInicial = lastSyncedAt ? new Date(lastSyncedAt).toISOString().split('T')[0] : undefined;

        let page = 1;
        while (true) {
          const blingPedidos = await blingClient.getPedidos(page, 100, dataInicial);
          if (blingPedidos.length === 0) break;
          console.log(`🔄 Sincronização: Processando página ${page} de pedidos do Bling...`);
          
          for (const bp of blingPedidos) {
            try {
              const clienteLocal = await clienteRepository.getByBlingId(userId, bp.contato.id);
              
              if (!clienteLocal || !clienteLocal.id) {
                console.warn(`⚠️ Sincronização: Pulando pedido Bling ${bp.numero} porque o cliente associado (Bling ID: ${bp.contato.id}) não existe localmente.`);
                continue;
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

              const savedPedido = await pedidoRepository.upsert(userId, pedido);
              stats.pedidos++;

              const itemsParaSalvar: ItemPedido[] = [];
              for (const item of bp.itens) {
                if (item.produto?.id) {
                  const produtoLocal = await produtoRepository.getByBlingId(userId, item.produto.id);
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
                await pedidoRepository.addItems(userId, itemsParaSalvar);
              }
            } catch (itemErr: any) {
              console.warn(`⚠️ Erro ao salvar pedido Bling ID ${bp.id} no Supabase: ${itemErr.message}`);
            }
          }
          page++;
          if (blingPedidos.length < 100) break;
        }
      } catch (err: any) {
        console.warn('⚠️ Sincronização Pedidos:', err.message);
      }

      // Atualizar watermark no sync_state
      await supabaseServer
        .from('sync_state')
        .upsert({ user_id: userId, entidade: 'pedidos',
          last_synced_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }, { onConflict: 'user_id, entidade' });

      console.log('✅ Sincronização Orbita: Concluída com sucesso!', stats);
      return { success: true, stats };
    } finally {
      this.isSyncing = false;
      if (dbLocked) {
        try {
          await supabaseServer.rpc('unlock_sync', { p_user_id: userId });
        } catch {
          // Silencioso se RPC não existir
        }
      }
    }
  }
}

export const syncService = new SyncService();
