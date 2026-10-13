import { supabaseServer } from '../lib/supabaseServer';
import type { VerifiedOrganizationScope } from '../lib/verifiedOrganizationScope';
import { Produto } from '../types';
import {
  classificarVinculoComBling,
  situacaoDoProdutoSchema,
  type SituacaoDoProduto,
  type VinculoComBling,
} from '../lib/config/produtoContract';
import { logger } from '../lib/observability/logger';
import { registrarFalhaInterna } from '../lib/observability/falhaInterna';
import { ReconciliacaoDeProdutoNecessaria } from './reconciliacaoDeProduto';

export { ReconciliacaoDeProdutoNecessaria } from './reconciliacaoDeProduto';
export type { MotivoDeReconciliacaoDeProduto } from './reconciliacaoDeProduto';

export class ProdutoRepository {
  async getAll(scope: VerifiedOrganizationScope): Promise<Produto[]> {
    const { data, error } = await supabaseServer
      .from('produtos')
      .select('*')
      .eq('organizacao_id', scope.organizationId)
      .order('nome', { ascending: true });

    if (error) {
      console.error('Erro ao buscar produtos no Supabase:', error);
      throw error;
    }

    return data || [];
  }

/**
   * O espelho `imagem_url` local de cada `bling_id` da página, numa consulta
   * só, e se o produto é gerenciado pelo ORBITA e está sem foto (onde imagem
   * no Bling é drift). Só leitura: a posse da imagem nunca é escrita aqui.
   */
  async imagensPorBlingId(
    scope: VerifiedOrganizationScope,
    blingIds: readonly string[],
  ): Promise<ReadonlyMap<string, { readonly imagemUrl: string | null; readonly gerenciadaSemFoto: boolean }>> {
    if (blingIds.length === 0) return new Map();
    const { data, error } = await supabaseServer
      .from('produtos')
      .select('bling_id, imagem_url, imagem_storage_path, imagem_bling_gerenciada_pelo_orbita')
      .eq('organizacao_id', scope.organizationId)
      .in('bling_id', [...blingIds]);
    if (error) throw error;
    return new Map((data ?? []).map((linha) => [String(linha.bling_id), {
      imagemUrl: (linha.imagem_url as string | null) ?? null,
      gerenciadaSemFoto: linha.imagem_bling_gerenciada_pelo_orbita === true && !linha.imagem_storage_path,
    }]));
  }

  async getByBlingId(scope: VerifiedOrganizationScope, blingId: string): Promise<Produto | null> {
    const { data, error } = await supabaseServer
      .from('produtos')
      .select('*')
      .eq('organizacao_id', scope.organizationId)
      .eq('bling_id', blingId)
      .maybeSingle();

    if (error) {
      console.error(`Erro ao buscar produto por Bling ID ${blingId} no Supabase:`, error);
      throw error;
    }
    return data || null;
  }

  /**
   * Grava o produto espelhado do Bling ou editado no formulário.
   *
   * `imagem_storage_path` e `imagem_bling_sync_path` NUNCA saem daqui: são a
   * foto escolhida no ORBITA e a confirmação de que ela chegou ao Bling, e este
   * é o caminho da sincronização e do webhook. Um `Produto` que chegasse com os
   * campos (lido de uma tela, por exemplo) sobrescreveria a escolha da pessoa
   * ou marcaria como sincronizado o que não foi. Quem escreve os dois é só
   * `ProdutoImagemRepository`. O lease da sincronização, a autoridade da imagem
   * (`imagem_bling_gerenciada_pelo_orbita`) e o drift também nunca saem daqui:
   * o Bling não toma nem devolve a posse da imagem.
   *
   * `imagem_url` é tri-estado: `undefined` não vai no payload (o valor local
   * fica), `null` grava ausência confirmada, texto grava a imagem confirmada.
   */
  async upsert(scope: VerifiedOrganizationScope, produto: Produto): Promise<Produto> {
    const payloadForUpsert = {
      ...produto,
      organizacao_id: scope.organizationId,
      user_id: scope.actorId,
    };
    delete payloadForUpsert.imagem_storage_path;
    delete payloadForUpsert.imagem_bling_sync_path;
    delete payloadForUpsert.imagem_bling_sync_lease_token;
    delete payloadForUpsert.imagem_bling_sync_lease_expires_at;
    delete payloadForUpsert.imagem_bling_gerenciada_pelo_orbita;
    delete payloadForUpsert.imagem_bling_divergencia_detectada_em;

    if (produto.bling_id && produto.id) {
      await this.removerDuplicadoPorBlingId(scope, produto.id, produto.bling_id);
    }

    if (produto.id) {
      const { data, error: updateError } = await supabaseServer
        .from('produtos')
        .update(payloadForUpsert)
        .eq('id', produto.id)
        .eq('organizacao_id', scope.organizationId)
        .select()
        .single();

      if (!updateError && data) {
        return data;
      }
    }

    if (payloadForUpsert.id) {
      delete payloadForUpsert.id;
    }

    const { data, error } = await supabaseServer
      .from('produtos')
      .upsert(payloadForUpsert, { onConflict: 'organizacao_id, bling_id' })
      .select()
      .single();

    if (error) {
      console.error('Erro ao persistir produto no Supabase (upsert):', error);
      throw error;
    }
    return data;
  }

  /** O duplicado por `bling_id` escopado, com o estado da foto — ou `null` se não existe. */
  private async lerPorBlingOuId(
    scope: VerifiedOrganizationScope,
    filtro: { readonly coluna: 'bling_id' | 'id'; readonly valor: string },
  ): Promise<{ id: string; imagem_storage_path: string | null } | null> {
    const { data, error } = await supabaseServer
      .from('produtos')
      .select('id, imagem_storage_path')
      .eq('organizacao_id', scope.organizationId)
      .eq(filtro.coluna, filtro.valor)
      .maybeSingle();
    if (error) throw error;
    return data ?? null;
  }

  /**
   * Antes de o produto editado assumir `blingId`, remove a OUTRA linha local
   * que já o tem — só se ela não tiver foto do ORBITA.
   *
   * - duplicado com foto → `ReconciliacaoDeProdutoNecessaria`, sem excluir e
   *   sem gravar nada: a edição de A não pode terminar persistida em B, e a
   *   foto de B não pode sumir;
   * - duplicado sem foto → `excluirDuplicadoSemFoto`, cuja precondição está no
   *   próprio `DELETE`. Zero linhas não é sucesso: relê e decide — ausente
   *   (outra operação removeu) segue; com foto (confirmada no meio) é
   *   reconciliação; qualquer outro estado falha explicitamente.
   *
   * Falha de banco na própria exclusão (FK de pedido, por exemplo) também é
   * reconciliação: B continua lá, e seguir gravaria a edição de A em B.
   */
  private async removerDuplicadoPorBlingId(
    scope: VerifiedOrganizationScope,
    produtoId: string,
    blingId: string,
  ): Promise<void> {
    const duplicado = await this.lerPorBlingOuId(scope, { coluna: 'bling_id', valor: blingId });
    if (!duplicado || duplicado.id === produtoId) return;
    if (duplicado.imagem_storage_path) throw new ReconciliacaoDeProdutoNecessaria('duplicado_com_foto');

    let removido: boolean;
    try {
      removido = await this.excluirDuplicadoSemFoto(scope, duplicado.id);
    } catch (delErr: unknown) {
      // B continua existindo com o mesmo `bling_id`. Seguir levaria o `update`
      // de A a esbarrar no único e o `upsert` por conflito a gravar a edição
      // de A em B. A causa fica no log do servidor; a resposta é de domínio.
      registrarFalhaInterna('produtos.deduplicacao.excluir_duplicado', delErr, { organizacaoId: scope.organizationId });
      throw new ReconciliacaoDeProdutoNecessaria('falha_ao_remover_duplicado');
    }
    if (removido) return;

    const atual = await this.lerPorBlingOuId(scope, { coluna: 'id', valor: duplicado.id });
    if (atual === null) return;
    if (atual.imagem_storage_path) throw new ReconciliacaoDeProdutoNecessaria('foto_confirmada_durante_deduplicacao');
    logger.warn('Duplicado sem foto não foi excluído pela deduplicação condicional', {
      subsystem: 'database',
      organizacaoId: scope.organizationId,
      produtoDuplicado: duplicado.id,
    });
    throw new ReconciliacaoDeProdutoNecessaria('estado_inesperado_na_deduplicacao');
  }

  /**
   * Exclusão exclusiva da deduplicação: remove o duplicado só se ele não tiver
   * foto do ORBITA, e a condição é parte do mesmo `DELETE`:
   *
   * `DELETE FROM produtos WHERE id = $1 AND organizacao_id = $2
   *    AND imagem_storage_path IS NULL RETURNING id`
   *
   * Uma foto confirmada entre a leitura e esta instrução faz o `DELETE` não
   * encontrar a linha — nunca apaga a linha e deixa o objeto órfão. Não é a
   * exclusão normal (`delete`), que remove com foto e devolve o caminho para
   * a limpeza posterior.
   *
   * @returns `true` quando exatamente uma linha saiu.
   */
  async excluirDuplicadoSemFoto(scope: VerifiedOrganizationScope, produtoId: string): Promise<boolean> {
    const { data, error } = await supabaseServer
      .from('produtos')
      .delete()
      .eq('id', produtoId)
      .eq('organizacao_id', scope.organizationId)
      .is('imagem_storage_path', null)
      .select('id');
    if (error) throw error;
    return (data ?? []).length === 1;
  }

  /**
   * O produto da organização do escopo, no que o arquivamento precisa: o
   * vínculo com o Bling classificado (`classificarVinculoComBling`) e a
   * situação. `null` quando não existe nesta organização.
   */
  async carregarParaArquivamento(
    scope: VerifiedOrganizationScope,
    id: string,
  ): Promise<{ readonly id: string; readonly vinculo: VinculoComBling; readonly situacao: SituacaoDoProduto } | null> {
    const { data, error } = await supabaseServer
      .from('produtos')
      .select('id, bling_id, situacao')
      .eq('id', id)
      .eq('organizacao_id', scope.organizationId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const situacao = situacaoDoProdutoSchema.parse(data.situacao);
    return { id: String(data.id), vinculo: classificarVinculoComBling(data.bling_id), situacao };
  }

  /**
   * Arquiva o produto (migration 75, `arquivar_produto`): trava a linha, é
   * idempotente e não mexe em estoque, reserva, foto nem pedidos. O ator vem
   * do escopo verificado.
   *
   * @returns `arquivado`, `ja_arquivado`, ou `nao_encontrado` quando o produto
   *   não é desta organização.
   */
  async arquivar(scope: VerifiedOrganizationScope, id: string): Promise<'arquivado' | 'ja_arquivado' | 'nao_encontrado'> {
    const { data, error } = await supabaseServer.rpc('arquivar_produto', {
      p_organizacao_id: scope.organizationId,
      p_produto_id: id,
      p_ator_id: scope.actorId,
    });
    if (error) {
      if (error.code === 'P0002') return 'nao_encontrado';
      throw error;
    }
    const linha = Array.isArray(data) ? data[0] : data;
    const desfecho = (linha as { desfecho?: unknown } | null)?.desfecho;
    if (desfecho === 'arquivado' || desfecho === 'ja_arquivado') return desfecho;
    throw new Error('arquivar_produto devolveu um desfecho fora do contrato');
  }
}

export const produtoRepository = new ProdutoRepository();
