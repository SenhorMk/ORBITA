import { supabaseServer } from '../lib/supabaseServer';
import { normalizarUf } from '../lib/normalizacao/ufDoCliente';
import type { VerifiedOrganizationScope } from '../lib/verifiedOrganizationScope';
import { Cliente } from '../types';

export class ClienteRepository {
  async getAll(scope: VerifiedOrganizationScope): Promise<Cliente[]> {
    const { data, error } = await supabaseServer
      .from('clientes')
      .select('*')
      .eq('organizacao_id', scope.organizationId)
      .order('nome', { ascending: true });

    if (error) {
      console.error('Erro ao buscar clientes no Supabase:', error);
      throw error;
    }
    return data || [];
  }

  async getByBlingId(scope: VerifiedOrganizationScope, blingId: string): Promise<Cliente | null> {
    const { data, error } = await supabaseServer
      .from('clientes')
      .select('*')
      .eq('organizacao_id', scope.organizationId)
      .eq('bling_id', blingId)
      .maybeSingle();

    if (error) {
      console.error(`Erro ao buscar cliente por Bling ID ${blingId} no Supabase:`, error);
      throw error;
    }
    return data || null;
  }

  async upsert(scope: VerifiedOrganizationScope, cliente: Cliente): Promise<Cliente> {
    const payload: Record<string, unknown> = {
      ...cliente,
      organizacao_id: scope.organizationId,
      user_id: scope.actorId,
      // `chk_cliente_uf` aceita `NULL` ou dois caracteres, e está certa. O que
      // chegava aqui era o `''` do formulário sem estado escolhido — e o
      // contato acabava criado no Bling e recusado no ORBITA. A normalização
      // mora nesta fronteira porque três caminhos gravam contato (a tela, o
      // webhook e a sincronização), e um deles normalizar não impede os outros
      // dois de reintroduzir o vazio. Ver `lib/normalizacao/ufDoCliente.ts`.
      uf: normalizarUf(cliente.uf),
    };
    delete payload.telefone_normalizado;

    const { data, error } = await supabaseServer
      .from('clientes')
      .upsert(payload, { onConflict: 'organizacao_id, bling_id' })
      .select()
      .single();

    if (error) {
      console.error('Erro ao persistir cliente no Supabase:', error);
      throw error;
    }
    return data;
  }

  /**
   * O cliente desta organização e o que impede apagá-lo, lidos **antes** de
   * qualquer efeito no Bling.
   *
   * `null` quando o id não existe **ou** é de outra organização — as duas
   * coisas são indistinguíveis para quem chama. O `blingId` devolvido é o
   * gravado na linha, e é o único que a exclusão usa.
   *
   * Dependências, conforme o catálogo real (auditoria de 2026-09-29):
   * - `pedidos.cliente_id` — FK `RESTRICT` e o gatilho `tg_prevenir_exclusao_cliente`;
   * - `titular_solicitacoes.titular_ref_cliente_id` — FK `RESTRICT` (LGPD);
   * - `retention_legal_holds` ativo sobre este cliente — impedimento de retenção;
   * - o mesmo contato do Bling como fornecedor de títulos
   *   (`titulos_financeiros.fornecedor_bling_id`) — vínculo lógico, sem FK:
   *   contatos e fornecedores são o mesmo cadastro no Bling, e apagá-lo lá
   *   atingiria as contas a pagar.
   */
  async carregarParaExclusao(
    scope: VerifiedOrganizationScope,
    id: string,
  ): Promise<{ readonly id: string; readonly blingId: string | null; readonly possuiHistorico: boolean } | null> {
    const { data: cliente, error } = await supabaseServer
      .from('clientes')
      .select('id, bling_id')
      .eq('id', id)
      .eq('organizacao_id', scope.organizationId)
      .maybeSingle();
    if (error) throw new Error('Falha ao carregar o cliente para exclusão.', { cause: error });
    if (!cliente) return null;

    const blingId = /^\d+$/u.test(String(cliente.bling_id ?? '')) ? String(cliente.bling_id) : null;

    const contagens = await Promise.all([
      contar(supabaseServer.from('pedidos').select('id', { count: 'exact', head: true })
        .eq('organizacao_id', scope.organizationId).eq('cliente_id', id)),
      contar(supabaseServer.from('titular_solicitacoes').select('id', { count: 'exact', head: true })
        .eq('organizacao_id', scope.organizationId).eq('titular_ref_cliente_id', id)),
      contar(supabaseServer.from('retention_legal_holds').select('id', { count: 'exact', head: true })
        .eq('organizacao_id', scope.organizationId).eq('entidade_id', id).is('liberado_em', null)),
      blingId === null
        ? Promise.resolve(0)
        : contar(supabaseServer.from('titulos_financeiros').select('id', { count: 'exact', head: true })
          .eq('organizacao_id', scope.organizationId).eq('fornecedor_bling_id', blingId)),
    ]);

    return { id: String(cliente.id), blingId, possuiHistorico: contagens.some((n) => n > 0) };
  }

  /**
   * Remove a linha e devolve **quantas** saíram.
   *
   * Zero não é sucesso: quem chama decide o que ele significa. Um pedido
   * criado depois da checagem faz o banco recusar (FK `RESTRICT` e gatilho), e
   * o erro sobe com a causa anexada para quem chama poder distingui-lo.
   */
  async excluir(scope: VerifiedOrganizationScope, id: string): Promise<number> {
    const { data, error } = await supabaseServer
      .from('clientes')
      .delete()
      .eq('id', id)
      .eq('organizacao_id', scope.organizationId)
      .select('id');

    if (error) throw new Error('Falha ao excluir o cliente.', { cause: error });
    return (data ?? []).length;
  }
}

/** Contagem exata de uma consulta `head`, ou exceção com a causa anexada. */
async function contar(
  consulta: PromiseLike<{ readonly count: number | null; readonly error: unknown }>,
): Promise<number> {
  const { count, error } = await consulta;
  if (error) throw new Error('Falha ao verificar dependências do cliente.', { cause: error });
  return count ?? 0;
}

export const clienteRepository = new ClienteRepository();
