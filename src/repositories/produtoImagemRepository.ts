import type { SupabaseClient } from '@supabase/supabase-js';

import type { VerifiedOrganizationScope } from '../lib/verifiedOrganizationScope';

/** O que as rotas de foto precisam do produto: o dono, o vínculo e o estado da foto. */
export interface ProdutoComFoto {
  readonly id: string;
  /** O `bling_id` gravado, só quando numérico. `null` = produto sem vínculo com o Bling. */
  readonly blingId: string | null;
  /** Estado DESEJADO: a foto escolhida no ORBITA, ou `null`. */
  readonly imagemStoragePath: string | null;
  /**
   * Estado CONFIRMADO no Bling: a foto que se sabe refletida lá (migration 72).
   * Igual ao desejado = sincronizada; diferente = pendente.
   */
  readonly imagemBlingSyncPath: string | null;
  /** A imagem espelhada do Bling — o que a tela mostra sem foto do ORBITA. */
  readonly imagemDoBling: string | null;
}

const texto = (valor: unknown): string | null => (typeof valor === 'string' && valor.trim() ? valor : null);

/** Só um id numérico do Bling é vínculo; `LOCAL-…` e vazio não são. */
export function blingIdDoVinculo(valor: unknown): string | null {
  const bruto = typeof valor === 'number' ? String(valor) : texto(valor)?.trim() ?? null;
  return bruto !== null && /^\d+$/u.test(bruto) ? bruto : null;
}

/**
 * A única escrita de `produtos.imagem_storage_path` e de
 * `produtos.imagem_bling_sync_path`.
 *
 * O cliente é service-role e passa por cima da RLS: toda consulta filtra por
 * `id` **e** `organizacao_id` do escopo verificado. Um produto de outra
 * organização é indistinguível de um produto inexistente.
 */
export class ProdutoImagemRepository {
  constructor(private readonly db: SupabaseClient) {}

  async carregar(scope: VerifiedOrganizationScope, produtoId: string): Promise<ProdutoComFoto | null> {
    const { data, error } = await this.db
      .from('produtos')
      .select('id, bling_id, imagem_storage_path, imagem_bling_sync_path, imagem_url')
      .eq('id', produtoId)
      .eq('organizacao_id', scope.organizationId)
      .maybeSingle();

    if (error) throw error;
    if (!data) return null;

    return {
      id: String(data.id),
      blingId: blingIdDoVinculo(data.bling_id),
      imagemStoragePath: texto(data.imagem_storage_path),
      imagemBlingSyncPath: texto(data.imagem_bling_sync_path),
      imagemDoBling: texto(data.imagem_url),
    };
  }

  /**
   * Compare-and-set do caminho da foto.
   *
   * Troca `anterior` por `novo` só se o banco ainda tiver `anterior`. O
   * `UPDATE ... WHERE imagem_storage_path = anterior` é atômico no Postgres:
   * duas trocas partindo do mesmo valor se serializam na trava da linha, e a
   * segunda reavalia o `WHERE` depois que a primeira commita — e não encontra
   * mais nada. `scripts/database-concurrency-foto-produto.mjs` prova isso com
   * duas transações reais.
   *
   * `pendenteNoBling` (só na remoção) grava junto, na mesma instrução, que o
   * Bling pode estar exibindo aquela foto: a remoção fica pendente lá até a
   * sincronização confirmar zero imagens.
   *
   * @returns `true` quando exatamente esta chamada fez a troca.
   */
  async trocarCaminho(
    scope: VerifiedOrganizationScope,
    produtoId: string,
    anterior: string | null,
    novo: string | null,
    opcoes: { readonly pendenteNoBling?: string } = {},
  ): Promise<boolean> {
    const valores = opcoes.pendenteNoBling === undefined
      ? { imagem_storage_path: novo }
      : { imagem_storage_path: novo, imagem_bling_sync_path: opcoes.pendenteNoBling };
    const alvo = this.db
      .from('produtos')
      .update(valores)
      .eq('id', produtoId)
      .eq('organizacao_id', scope.organizationId);
    const comPrecondicao = anterior === null
      ? alvo.is('imagem_storage_path', null)
      : alvo.eq('imagem_storage_path', anterior);

    const { data, error } = await comPrecondicao.select('id');
    if (error) throw error;
    return (data ?? []).length === 1;
  }

  /**
   * Marca `desejado` como refletido no Bling — **só se ainda for o desejado**.
   *
   * `UPDATE ... SET imagem_bling_sync_path = desejado WHERE imagem_storage_path
   * = desejado` (ou `IS NULL` para a remoção). Uma sincronização da foto A que
   * termina depois de o usuário trocar para B encontra B na linha e não marca
   * nada: o resultado remoto de A é obsoleto.
   *
   * @returns `true` quando a marcação valeu para o estado desejado atual.
   */
  async confirmarSincronizacao(scope: VerifiedOrganizationScope, produtoId: string, desejado: string | null): Promise<boolean> {
    // Remoção confirmada: o Bling acabou de ser lido sem imagens, então o
    // espelho também fica vazio, e a foto removida não volta pela imagem do Bling.
    const valores = desejado === null ? { imagem_bling_sync_path: null, imagem_url: null } : { imagem_bling_sync_path: desejado };
    const alvo = this.db
      .from('produtos')
      .update(valores)
      .eq('id', produtoId)
      .eq('organizacao_id', scope.organizationId);
    const comPrecondicao = desejado === null
      ? alvo.is('imagem_storage_path', null)
      : alvo.eq('imagem_storage_path', desejado);

    const { data, error } = await comPrecondicao.select('id');
    if (error) throw error;
    return (data ?? []).length === 1;
  }
}
