import { supabaseServer } from '../lib/supabaseServer';
import { normalizarUf } from '../lib/normalizacao/ufDoCliente';
import type { VerifiedOrganizationScope } from '../lib/verifiedOrganizationScope';
import { Cliente } from '../types';

/** Categoria de retenção dos dados pessoais de cliente final — `retention_policy_registry`, migration 51. */
export const CATEGORIA_DE_RETENCAO_DO_CLIENTE = 'cliente_final_pii';

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
   * - `retention_legal_holds` ativo sobre este cliente — impedimento de
   *   retenção. A identidade de um hold é (organização, **categoria**,
   *   entidade): só conta o da categoria de cliente, `cliente_final_pii`
   *   (migration 51). Um hold de outra categoria com o mesmo `entidade_id` não
   *   é sobre este cliente;
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
        .eq('organizacao_id', scope.organizationId).eq('categoria', CATEGORIA_DE_RETENCAO_DO_CLIENTE)
        .eq('entidade_id', id).is('liberado_em', null)),
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
  /**
   * Registra a exclusão feita no Bling (migration 77,
   * `registrar_exclusao_de_contato_no_bling`): o contato local é marcado, não
   * apagado — pedidos, casos e solicitações continuam apontando para ele — e
   * nenhuma gravação posterior o recria. Idempotente.
   *
   * @param excluidoNoBlingEm - A data do evento no Bling, quando veio.
   * @returns `registrado`, `registrado_sem_contato` (o ORBITA nunca o teve) ou
   *   `ja_registrado` (reentrega).
   */
  async registrarExclusaoNoBling(
    scope: VerifiedOrganizationScope,
    blingId: string,
    excluidoNoBlingEm: string | null,
  ): Promise<DesfechoDaExclusaoDeContato> {
    const { data, error } = await supabaseServer.rpc('registrar_exclusao_de_contato_no_bling', {
      p_organizacao_id: scope.organizationId,
      p_bling_id: blingId,
      p_excluido_no_bling_em: excluidoNoBlingEm,
    });
    if (error) throw error;
    const desfecho = desfechoDaLinha(data);
    if (desfecho === 'registrado' || desfecho === 'registrado_sem_contato' || desfecho === 'ja_registrado') return desfecho;
    throw new Error('registrar_exclusao_de_contato_no_bling devolveu um desfecho fora do contrato');
  }

  /** Há exclusão vigente deste contato no Bling, nesta organização? */
  async exclusaoVigenteNoBling(scope: VerifiedOrganizationScope, blingId: string): Promise<boolean> {
    const { data, error } = await supabaseServer
      .from('contatos_excluidos_no_bling')
      .select('id')
      .eq('organizacao_id', scope.organizationId)
      .eq('bling_id', blingId)
      .is('reativado_em', null)
      .maybeSingle();
    if (error) throw error;
    return data !== null;
  }

  /**
   * Encerra a exclusão vigente (migration 77, `reativar_contato_excluido_no_bling`).
   * O único caminho de volta: quem chama já confirmou o contato ativo no
   * Bling, e o banco confere de novo que o ator administra a organização.
   *
   * @returns `reativado`, `nao_excluido`, ou `negado` quando o ator não
   *   administra a organização.
   */
  async reativarExcluidoNoBling(
    scope: VerifiedOrganizationScope,
    blingId: string,
  ): Promise<'reativado' | 'nao_excluido' | 'negado'> {
    const { data, error } = await supabaseServer.rpc('reativar_contato_excluido_no_bling', {
      p_organizacao_id: scope.organizationId,
      p_bling_id: blingId,
      p_ator_id: scope.actorId,
    });
    if (error) {
      if (error.code === '42501') return 'negado';
      throw error;
    }
    const desfecho = desfechoDaLinha(data);
    if (desfecho === 'reativado' || desfecho === 'nao_excluido') return desfecho;
    throw new Error('reativar_contato_excluido_no_bling devolveu um desfecho fora do contrato');
  }

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

/** Desfecho de `registrar_exclusao_de_contato_no_bling`. */
export type DesfechoDaExclusaoDeContato = 'registrado' | 'registrado_sem_contato' | 'ja_registrado';

function desfechoDaLinha(data: unknown): unknown {
  const linha = Array.isArray(data) ? data[0] : data;
  return (linha as { desfecho?: unknown } | null)?.desfecho;
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
