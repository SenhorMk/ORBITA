import { extractProductImageUrl } from './bling';

/**
 * O espelho `produtos.imagem_url` é TRI-ESTADO, e os três não se confundem:
 *
 * - `ImagemConfirmada`: o Bling mostrou uma imagem → grava a URL atual;
 * - `AusenciaConfirmada`: uma leitura COMPLETA do produto mostrou zero
 *   imagens → grava `null` explicitamente;
 * - `Desconhecida`: o payload não traz a mídia e a leitura complementar falhou
 *   (ou não foi feita) → o valor local fica como está.
 *
 * Colapsar ausência e desconhecido num `undefined` deixava no ORBITA, para
 * sempre, a imagem que o Bling já não tem.
 */
export type ImagemDoBling =
  | { readonly _tag: 'ImagemConfirmada'; readonly url: string }
  | { readonly _tag: 'AusenciaConfirmada' }
  | { readonly _tag: 'Desconhecida' };

/**
 * A leitura é autoritativa sobre mídia? Só quando traz o bloco de mídia
 * completo, como o `GET /produtos/{id}` (`midia.imagens.internas` e
 * `externas`, provado em 2026-10-02). A ausência de um campo de imagem num
 * payload sem esse bloco não prova nada.
 */
export function midiaCompleta(dados: unknown): boolean {
  if (!dados || typeof dados !== 'object') return false;
  const imagens = (dados as { midia?: { imagens?: { internas?: unknown; externas?: unknown } } }).midia?.imagens;
  return Array.isArray(imagens?.internas) && Array.isArray(imagens?.externas);
}

export function imagemDoBling(dados: unknown, opcoes: { readonly autoritativo: boolean }): ImagemDoBling {
  const url = extractProductImageUrl(dados);
  if (url) return { _tag: 'ImagemConfirmada', url };
  return opcoes.autoritativo ? { _tag: 'AusenciaConfirmada' } : { _tag: 'Desconhecida' };
}

/** O valor de `imagem_url` a gravar: URL, `null` explícito, ou o valor local anterior. */
export function imagemUrlParaGravar(imagem: ImagemDoBling, anterior: string | null | undefined): string | null | undefined {
  switch (imagem._tag) {
    case 'ImagemConfirmada':
      return imagem.url;
    case 'AusenciaConfirmada':
      return null;
    case 'Desconhecida':
      return anterior ?? undefined;
  }
}

/**
 * A sincronização de catálogo lê a LISTAGEM, que confirma uma imagem presente
 * mas não é autoritativa sobre ausência. Sem imagem na listagem:
 *
 * - local também sem imagem → nada a decidir, sem chamada extra;
 * - local com imagem → UMA leitura de detalhe decide: mídia completa sem
 *   imagem é ausência confirmada (`null`); leitura que falhou é desconhecida
 *   (o valor local fica).
 *
 * Assim não há GET extra para cada produto: só para os que podem ter perdido
 * a imagem no Bling.
 */
export async function imagemDaListagem(
  item: unknown,
  imagemLocal: string | null | undefined,
  lerDetalhe: () => Promise<unknown>,
): Promise<ImagemDoBling> {
  const daListagem = imagemDoBling(item, { autoritativo: false });
  if (daListagem._tag === 'ImagemConfirmada' || !imagemLocal) return daListagem;

  let detalhe: unknown = null;
  try {
    detalhe = await lerDetalhe();
  } catch {
    detalhe = null;
  }
  return imagemDoBling(detalhe, { autoritativo: midiaCompleta(detalhe) });
}

/** `imagemDaListagem` já convertida no valor a gravar (o espelho local decide se vale ler o detalhe). */
export async function imagemUrlDaListagem(
  item: unknown,
  imagemLocal: string | null | undefined,
  lerDetalhe: () => Promise<unknown>,
): Promise<string | null | undefined> {
  return imagemUrlParaGravar(await imagemDaListagem(item, imagemLocal, lerDetalhe), imagemLocal);
}
