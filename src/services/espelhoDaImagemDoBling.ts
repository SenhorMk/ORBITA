import { registrarFalhaInterna } from '../lib/observability/falhaInterna';
import { supabaseServer } from '../lib/supabaseServer';
import type { VerifiedOrganizationScope } from '../lib/verifiedOrganizationScope';
import { ProdutoImagemRepository } from '../repositories/produtoImagemRepository';
import { produtoRepository } from '../repositories/produtoRepository';
import type { BlingPort } from './blingPort';
import { imagemDaListagem, imagemUrlParaGravar, type ImagemDoBling } from './imagemDoBling';

/**
 * O lado Bling → ORBITA da imagem: o espelho `imagem_url` (tri-estado, ver
 * `imagemDoBling`) e o registro de drift num produto que o ORBITA gerencia.
 *
 * O Bling nunca toma nem devolve a posse da imagem. Quando uma leitura ATUAL
 * mostra imagem num produto gerenciado e sem foto — o ORBITA deseja nenhuma
 * imagem —, isso é drift: a função SQL registra o instante (só em produto
 * gerenciado, sem foto e sem lease vigente), o estado passa a `pendente` e
 * "Tentar sincronizar novamente" limpa o Bling de novo. A imagem continua sem
 * aparecer como fallback.
 *
 * Só leitura atual conta: a listagem e o detalhe lidos agora. Um payload de
 * webhook pode descrever um momento já superado (inclusive estados
 * intermediários de uma sincronização do próprio ORBITA) e não registra drift.
 */
const fotos = new ProdutoImagemRepository(supabaseServer);

export async function registrarSeDivergente(
  scope: VerifiedOrganizationScope,
  blingId: string,
  imagem: ImagemDoBling,
  leituraAtual: boolean,
): Promise<void> {
  if (!leituraAtual || imagem._tag !== 'ImagemConfirmada') return;
  try {
    await fotos.registrarDivergencia(scope, blingId);
  } catch (erro: unknown) {
    // Drift é diagnóstico: falhar aqui não derruba a sincronização nem o webhook.
    registrarFalhaInterna('bling.foto.registrar_divergencia', erro, { organizacaoId: scope.organizationId });
  }
}

/**
 * Para uma página da listagem: lê o espelho local uma vez e devolve, por item,
 * o `imagem_url` a gravar — registrando drift nos produtos gerenciados sem foto.
 */
export async function espelhoDaPagina(
  scope: VerifiedOrganizationScope,
  blingClient: Pick<BlingPort, 'getProduto'>,
  blingIds: readonly string[],
): Promise<(item: { readonly id: number | string }) => Promise<string | null | undefined>> {
  const locais = await produtoRepository.imagensPorBlingId(scope, blingIds);
  return async (item) => {
    const blingId = String(item.id);
    const local = locais.get(blingId);
    const imagem = await imagemDaListagem(item, local?.imagemUrl, () => blingClient.getProduto(blingId));
    if (local?.gerenciadaSemFoto) await registrarSeDivergente(scope, blingId, imagem, true);
    return imagemUrlParaGravar(imagem, local?.imagemUrl);
  };
}
