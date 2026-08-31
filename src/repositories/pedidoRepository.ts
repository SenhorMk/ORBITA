import { supabaseServer } from '../lib/supabaseServer';
import type { VerifiedOrganizationScope } from '../lib/verifiedOrganizationScope';
import { Pedido, ItemPedido, Nfe, Cliente } from '../types';

// Tipo enriquecido para visualização no dashboard
export interface PedidoEnriquecido extends Pedido {
  cliente?: Cliente;
  itens?: ItemPedido[];
  nfe?: Nfe;
}

interface RawDocumentoFiscal {
  id?: string;
  organizacao_id?: string;
  user_id?: string;
  bling_id?: string;
  numero?: string;
  chave_acesso?: string;
  chave?: string;
  status?: string;
  pedido_id?: string;
  emitida_em?: string;
  created_at?: string;
  updated_at?: string;
}

function mapDocumentoToNfe(doc?: RawDocumentoFiscal | null): Nfe | undefined {
  if (!doc) return undefined;
  return {
    id: doc.id,
    organizacao_id: doc.organizacao_id,
    user_id: doc.user_id,
    bling_id: doc.bling_id || '',
    numero: doc.numero || '',
    chave: doc.chave_acesso || doc.chave || '',
    status: doc.status || 'Pendente',
    pedido_id: doc.pedido_id || '',
    emitida_em: doc.emitida_em,
    created_at: doc.created_at,
    updated_at: doc.updated_at,
  };
}

export class PedidoRepository {
  /**
   * Pedidos da organização, com cliente e nota fiscal embutidos.
   *
   * Os dois embeds são desambiguados **pelo nome da constraint**, e isso não é
   * estilo: as migrations de tenancy criaram uma segunda chave estrangeira
   * composta em cima da original, então `documentos_fiscais(*)` sozinho é
   * ambíguo e o PostgREST recusa a consulta inteira:
   *
   *   PGRST201 — Could not embed because more than one relationship was found
   *
   * Isso derrubava TODA leitura de pedidos do painel. Havia um fallback logo
   * abaixo que existia para essa hipótese — mas ele repetia o mesmo embed
   * ambíguo, falhava igual, e devolvia `[]`. O painel então mostrava
   * "R$ 0,00" e "0 pedidos" com os pedidos gravados no banco.
   *
   * O fallback saiu: com o embed correto ele não tem hipótese que atenda, e
   * um caminho alternativo que devolve lista vazia em silêncio é pior que
   * não ter caminho nenhum. Guarda: `postgrest-embeds.test.ts`.
   */
  async getAllEnriched(scope: VerifiedOrganizationScope): Promise<PedidoEnriquecido[]> {
    const { data, error } = await supabaseServer
      .from('pedidos')
      .select(`
        *,
        cliente:clientes!fk_pedido_cliente(*),
        nfe:documentos_fiscais!documentos_fiscais_pedido_id_fkey(*)
      `)
      .eq('organizacao_id', scope.organizationId)
      .order('data', { ascending: false });

    if (error) {
      console.error('Erro ao buscar pedidos no Supabase:', error);
      throw error;
    }

    return ((data ?? []) as PedidoEnriquecido[]).map((p) => ({
      ...p,
      nfe: Array.isArray(p.nfe) ? mapDocumentoToNfe(p.nfe[0]) : mapDocumentoToNfe(p.nfe),
    }));
  }

  async getById(scope: VerifiedOrganizationScope, id: string): Promise<Pedido | null> {
    const { data, error } = await supabaseServer
      .from('pedidos')
      .select('*')
      .eq('id', id)
      .eq('organizacao_id', scope.organizationId)
      .maybeSingle();

    if (error) {
      console.error(`Erro ao buscar pedido por ID ${id} no Supabase:`, error);
      throw error;
    }
    return data || null;
  }

  async getByBlingId(scope: VerifiedOrganizationScope, blingId: string): Promise<Pedido | null> {
    const { data, error } = await supabaseServer
      .from('pedidos')
      .select('*')
      .eq('organizacao_id', scope.organizationId)
      .eq('bling_id', blingId)
      .maybeSingle();

    if (error) {
      console.error(`Erro ao buscar pedido por Bling ID ${blingId} no Supabase:`, error);
      throw error;
    }
    return data || null;
  }

  /** Delete an order only inside the previously verified organization boundary. */
  async deleteByBlingId(scope: VerifiedOrganizationScope, blingId: string): Promise<void> {
    const { error } = await supabaseServer
      .from('pedidos')
      .delete()
      .eq('organizacao_id', scope.organizationId)
      .eq('bling_id', blingId);

    if (error) {
      console.error(`Erro ao apagar pedido por Bling ID ${blingId} no Supabase:`, error);
      throw error;
    }
  }

  /**
   * Marca como `Cancelado` o pedido correspondente a um `bling_id`, dentro do
   * limite organizacional já verificado.
   *
   * Decisão do proprietário (31/08, ticket 11): uma exclusão feita **no Bling**
   * cancela o pedido no ORBITA, nunca o apaga. Preserva histórico, estoque e
   * financeiro auditáveis, e sobrevive a um evento espúrio ou reentregue —
   * `deleteByBlingId` não teria volta.
   *
   * @returns `true` se havia um pedido local para cancelar; `false` se o evento
   *          se refere a um pedido que o ORBITA nunca conheceu (caso normal:
   *          pedido criado e excluído no Bling sem nunca ter sincronizado).
   */
  async markCancelledByBlingId(scope: VerifiedOrganizationScope, blingId: string): Promise<boolean> {
    const { data, error } = await supabaseServer
      .from('pedidos')
      .update({ status: 'Cancelado' })
      .eq('organizacao_id', scope.organizationId)
      .eq('bling_id', blingId)
      .select('id');

    if (error) {
      console.error(`Erro ao cancelar pedido por Bling ID ${blingId} no Supabase:`, error);
      throw error;
    }
    return (data?.length ?? 0) > 0;
  }

  async upsert(scope: VerifiedOrganizationScope, pedido: Pedido): Promise<Pedido> {
    const payload = {
      ...pedido,
      organizacao_id: scope.organizationId,
      user_id: scope.actorId,
    };
    const { data, error } = await supabaseServer
      .from('pedidos')
      .upsert(payload, { onConflict: 'organizacao_id, bling_id' })
      .select()
      .single();

    if (error) {
      console.error('Erro ao persistir pedido no Supabase:', error);
      throw error;
    }
    return data;
  }

  // Operações para Itens de Pedido
  async addItems(scope: VerifiedOrganizationScope, items: ItemPedido[]): Promise<void> {
    const itemsWithOrg = items.map((i) => ({
      ...i,
      organizacao_id: scope.organizationId,
      user_id: scope.actorId,
    }));
    const { error } = await supabaseServer
      .from('itens_pedido')
      .upsert(itemsWithOrg, { onConflict: 'pedido_id,produto_id' });

    if (error) {
      console.error('Erro ao salvar itens de pedido no Supabase:', error);
      throw error;
    }
  }

  // Operações para Documentos Fiscais (Canônico)
  async upsertNfe(scope: VerifiedOrganizationScope, nfe: Nfe): Promise<Nfe> {
    const payload = {
      organizacao_id: scope.organizationId,
      user_id: scope.actorId,
      bling_id: nfe.bling_id,
      numero: nfe.numero,
      chave_acesso: nfe.chave || null,
      status: nfe.status,
      pedido_id: nfe.pedido_id,
      tipo: 'NFE',
    };

    const { data, error } = await supabaseServer
      .from('documentos_fiscais')
      .upsert(payload, { onConflict: 'organizacao_id, bling_id' })
      .select()
      .single();

    if (error) {
      console.error('Erro ao persistir Documento Fiscal no Supabase:', error);
      throw error;
    }

    return {
      id: data.id,
      organizacao_id: data.organizacao_id,
      user_id: data.user_id,
      bling_id: data.bling_id,
      numero: data.numero,
      chave: data.chave_acesso || '',
      status: data.status,
      pedido_id: data.pedido_id,
      emitida_em: data.emitida_em,
      created_at: data.created_at,
      updated_at: data.updated_at,
    };
  }

  // Obter faturamento mensal total
  async getFaturamentoMensal(scope: VerifiedOrganizationScope): Promise<number> {
    const pedidos = await this.getAllEnriched(scope);
    const trintaDiasAtras = Date.now() - 30 * 24 * 60 * 60 * 1000;

    return pedidos
      .filter((p) => new Date(p.data).getTime() >= trintaDiasAtras)
      .reduce((acc, p) => acc + Number(p.total || 0), 0);
  }

  // Estatísticas para o Dashboard
  async getDashboardStats(scope: VerifiedOrganizationScope): Promise<{
    faturamento30: number;
    total: number;
    pendentes: number;
    cancelados: number;
    atendidos: number;
  }> {
    const pedidos = await this.getAllEnriched(scope);
    const trintaDiasAtras = Date.now() - 30 * 24 * 60 * 60 * 1000;

    let faturamento30 = 0;
    let pendentes = 0;
    let cancelados = 0;
    let atendidos = 0;

    for (const p of pedidos) {
      const valor = Number(p.total || 0);
      const dataTime = new Date(p.data).getTime();
      if (dataTime >= trintaDiasAtras) {
        faturamento30 += valor;
      }

      const st = (p.status || '').toLowerCase();
      if (st.includes('pend') || st.includes('aberto')) {
        pendentes++;
      } else if (st.includes('canc')) {
        cancelados++;
      } else if (st.includes('atend') || st.includes('fatur')) {
        atendidos++;
      }
    }

    return {
      faturamento30,
      total: pedidos.length,
      pendentes,
      cancelados,
      atendidos,
    };
  }
}

export const pedidoRepository = new PedidoRepository();
