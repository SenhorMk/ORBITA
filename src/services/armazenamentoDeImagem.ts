import type { SupabaseClient } from '@supabase/supabase-js';

import { BUCKET_PRODUTO_IMAGENS } from '@/lib/config/produtoImagemContract';

/**
 * O Storage visto pelas rotas de foto: quatro operações, cada uma com desfecho
 * tipado. Nenhuma devolve o texto de erro do Supabase — ele não pode chegar à
 * resposta, e quem chama só precisa saber o que aconteceu.
 */
export type AutorizacaoDeUpload =
  | { readonly _tag: 'Autorizado'; readonly token: string }
  | { readonly _tag: 'Indisponivel'; readonly causa: unknown };

export type InspecaoDeObjeto =
  | { readonly _tag: 'Presente'; readonly tamanho: number | null; readonly tipo: string | null }
  | { readonly _tag: 'Ausente' }
  | { readonly _tag: 'Indisponivel'; readonly causa: unknown };

export type RemocaoDeObjeto =
  | { readonly _tag: 'Removido' }
  | { readonly _tag: 'Falhou'; readonly causa: unknown };

export type LeiturasAssinadas =
  | { readonly _tag: 'Assinadas'; readonly urls: ReadonlyMap<string, string> }
  | { readonly _tag: 'Indisponivel'; readonly causa: unknown };

export interface ArmazenamentoDeImagemPort {
  /** Token de upload para EXATAMENTE este caminho, sem sobrescrever objeto existente. */
  autorizarUpload(caminho: string): Promise<AutorizacaoDeUpload>;
  inspecionar(caminho: string): Promise<InspecaoDeObjeto>;
  remover(caminhos: readonly string[]): Promise<RemocaoDeObjeto>;
  /** URLs de leitura temporárias, numa chamada só. Caminho que falhou fica fora do mapa. */
  assinarLeituras(caminhos: readonly string[], validadeS: number): Promise<LeiturasAssinadas>;
}

/** `info` de objeto inexistente volta como 400/404 com `statusCode` "404", conforme a versão do Storage. */
function ehObjetoAusente(erro: { status?: number; statusCode?: string; message?: string }): boolean {
  return erro.status === 404 || erro.statusCode === '404' || /not.?found/iu.test(erro.message ?? '');
}

function numeroOuNulo(valor: unknown): number | null {
  return typeof valor === 'number' && Number.isFinite(valor) ? valor : null;
}

function textoOuNulo(valor: unknown): string | null {
  return typeof valor === 'string' && valor.length > 0 ? valor : null;
}

/**
 * Implementação pela API oficial do Supabase Storage.
 *
 * O cliente é service-role e é só do servidor. Nada aqui toca
 * `storage.objects` por SQL: upload, inspeção, remoção e assinatura passam pela
 * API, que aplica as regras do bucket (privado, JPEG/PNG/WebP, 3 MB).
 */
export class SupabaseArmazenamentoDeImagem implements ArmazenamentoDeImagemPort {
  constructor(private readonly client: SupabaseClient) {}

  private bucket() {
    return this.client.storage.from(BUCKET_PRODUTO_IMAGENS);
  }

  async autorizarUpload(caminho: string): Promise<AutorizacaoDeUpload> {
    const { data, error } = await this.bucket().createSignedUploadUrl(caminho, { upsert: false });
    if (error) return { _tag: 'Indisponivel', causa: error };
    return { _tag: 'Autorizado', token: data.token };
  }

  async inspecionar(caminho: string): Promise<InspecaoDeObjeto> {
    const { data, error } = await this.bucket().info(caminho);
    if (error) return ehObjetoAusente(error) ? { _tag: 'Ausente' } : { _tag: 'Indisponivel', causa: error };
    const metadata: Record<string, unknown> = data.metadata ?? {};
    return {
      _tag: 'Presente',
      tamanho: numeroOuNulo(data.size) ?? numeroOuNulo(metadata.size),
      tipo: textoOuNulo(data.contentType) ?? textoOuNulo(metadata.mimetype),
    };
  }

  async remover(caminhos: readonly string[]): Promise<RemocaoDeObjeto> {
    const { error } = await this.bucket().remove([...caminhos]);
    return error ? { _tag: 'Falhou', causa: error } : { _tag: 'Removido' };
  }

  async assinarLeituras(caminhos: readonly string[], validadeS: number): Promise<LeiturasAssinadas> {
    if (caminhos.length === 0) return { _tag: 'Assinadas', urls: new Map() };
    const { data, error } = await this.bucket().createSignedUrls([...caminhos], validadeS);
    if (error) return { _tag: 'Indisponivel', causa: error };

    const urls = new Map<string, string>();
    for (const item of data) {
      if (!item.error && item.path && item.signedUrl) urls.set(item.path, item.signedUrl);
    }
    return { _tag: 'Assinadas', urls };
  }
}
