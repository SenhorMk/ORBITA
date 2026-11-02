import { supabaseServer } from '../lib/supabaseServer';
import type { VerifiedOrganizationScope } from '../lib/verifiedOrganizationScope';
import { Pedido, ItemPedido, Nfe, Cliente } from '../types';
import { faturamentoNaJanela } from '@/lib/metricas/vendasAtivas';

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
   * Decisão de produto: uma exclusão feita **no Bling**
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
  /**
   * Registra a NF-e devolvida pelo Bling. A RPC `registrar_documento_fiscal_emitido`
   * (migration 83) faz o upsert por (organização, id do Bling) e grava
   * `fiscal.document_issued` na mesma transação: se o evento for recusado, a
   * nota não fica e esta chamada lança.
   */
  async upsertNfe(scope: VerifiedOrganizationScope, nfe: Nfe, auditoria: { readonly correlationId: string }): Promise<Nfe> {
    const { data, error } = await supabaseServer.rpc('registrar_documento_fiscal_emitido', {
      p_organizacao_id: scope.organizationId,
      p_ator_id: scope.actorId,
      p_pedido_id: nfe.pedido_id,
      p_bling_id: nfe.bling_id,
      p_numero: nfe.numero,
      p_chave_acesso: nfe.chave || null,
      p_status: nfe.status,
      p_correlation_id: auditoria.correlationId,
    });

    if (error) throw new Error('Falha ao registrar o documento fiscal.', { cause: error });
    const registrada = mapDocumentoToNfe(data as RawDocumentoFiscal | null);
    if (!registrada) throw new Error('O registro do documento fiscal não devolveu a nota.');
    return registrada;
  }

  /**
   * Sonda sem efeito: a RPC recusa argumentos nulos com `22023` antes de ler
   * ou gravar qualquer coisa. Qualquer outra resposta (função ausente,
   * `PGRST202`, ou banco fora) conta como indisponível: falha fechada.
   */
  async registroDeNfeDisponivel(): Promise<boolean> {
    const { error } = await supabaseServer.rpc('registrar_documento_fiscal_emitido', {
      p_organizacao_id: null,
      p_ator_id: null,
      p_pedido_id: null,
      p_bling_id: null,
      p_numero: null,
      p_chave_acesso: null,
      p_status: null,
      p_correlation_id: null,
    });
    return error?.code === '22023';
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
  /**
   * As estatísticas do painel.
   *
   * `faturamento30` conta só VENDA ATIVA (`vendasAtivas.ts`). Antes somava
   * todo pedido da janela, cancelado incluído: medido no staging, três pedidos
   * de R$ 40 — um cancelado — viravam R$ 120 de faturamento e R$ 50,40 de
   * lucro. As CONTAGENS por status continuam contando tudo, porque a de
   * cancelados existe justamente para mostrar quantos são.
   *
   * `faturamento30Anterior` é a janela imediatamente anterior, de mesmo
   * tamanho. Existe para o painel comparar com um número real: o "vs mês
   * anterior" era calculado sobre R$ 12.500 escritos no código.
   */
  async getDashboardStats(scope: VerifiedOrganizationScope, agora: Date = new Date()): Promise<{
    faturamento30: number;
    faturamento30Anterior: number;
    total: number;
    pendentes: number;
    cancelados: number;
    atendidos: number;
  }> {
    const pedidos = await this.getAllEnriched(scope);
    const JANELA_MS = 30 * 24 * 60 * 60 * 1000;
    const fim = new Date(agora.getTime());
    const inicio = new Date(agora.getTime() - JANELA_MS);
    const inicioAnterior = new Date(agora.getTime() - 2 * JANELA_MS);

    let pendentes = 0;
    let cancelados = 0;
    let atendidos = 0;

    for (const p of pedidos) {
      const st = (p.status || '').toLowerCase();
      if (st.includes('canc')) {
        cancelados++;
      } else if (st.includes('pend') || st.includes('aberto')) {
        pendentes++;
      } else if (st.includes('atend') || st.includes('fatur')) {
        atendidos++;
      }
    }

    return {
      faturamento30: faturamentoNaJanela(pedidos, inicio, fim),
      faturamento30Anterior: faturamentoNaJanela(pedidos, inicioAnterior, inicio),
      total: pedidos.length,
      pendentes,
      cancelados,
      atendidos,
    };
  }
}

export const pedidoRepository = new PedidoRepository();
