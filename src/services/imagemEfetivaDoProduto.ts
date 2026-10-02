import { imagemGerenciadaPeloOrbita, VALIDADE_DA_LEITURA_ASSINADA_S } from '@/lib/config/produtoImagemContract';
import { registrarFalhaInterna } from '@/lib/observability/falhaInterna';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import type { Produto } from '@/types';

import type { ArmazenamentoDeImagemPort } from './armazenamentoDeImagem';

/**
 * Os produtos como a tela os apresenta: `imagem_url` passa a ser a imagem
 * EFETIVA, com uma precedência só:
 *
 * 1. a foto escolhida no ORBITA (`imagem_storage_path`), por URL assinada;
 * 2. a imagem espelhada do Bling (`imagem_url`) — SÓ se o ORBITA nunca adotou
 *    a imagem do produto (`imagem_bling_gerenciada_pelo_orbita = false`);
 * 3. nenhuma — a tela desenha o placeholder.
 *
 * Produto gerenciado pelo ORBITA e sem foto deseja NENHUMA imagem: o espelho
 * nunca volta para a tela — nem durante a remoção pendente, nem depois dela,
 * nem se um webhook ou uma sincronização atrasada regravar `imagem_url`.
 *
 * O caminho persistido segue no objeto, separado: é ele que o formulário usa
 * como precondição ao trocar ou remover a foto. A URL assinada nunca volta ao
 * banco: é gerada aqui, a cada leitura, e expira.
 *
 * As assinaturas saem numa chamada só (`createSignedUrls`). Se o Storage não
 * responder, o catálogo não cai: o produto com foto mostra o placeholder (é
 * gerenciado, então o espelho do Bling não vale), e a falha vai para o log com
 * a organização. É apresentação — nenhum dado muda,
 * e a próxima leitura tenta de novo.
 */
export async function comImagemEfetiva(
  scope: VerifiedOrganizationScope,
  produtos: readonly Produto[],
  armazenamento: Pick<ArmazenamentoDeImagemPort, 'assinarLeituras'>,
): Promise<Produto[]> {
  const caminhos = [...new Set(
    produtos.map((produto) => produto.imagem_storage_path).filter((caminho): caminho is string => !!caminho),
  )];

  let urls: ReadonlyMap<string, string> = new Map();
  if (caminhos.length > 0) {
    const assinadas = await armazenamento.assinarLeituras(caminhos, VALIDADE_DA_LEITURA_ASSINADA_S);
    if (assinadas._tag === 'Assinadas') {
      urls = assinadas.urls;
    } else {
      registrarFalhaInterna('produtos.imagem.assinar_leitura', assinadas.causa, { organizacaoId: scope.organizationId });
    }
  }

  return produtos.map((produto) => {
    const daFoto = produto.imagem_storage_path ? urls.get(produto.imagem_storage_path) : undefined;
    const gerenciada = imagemGerenciadaPeloOrbita({
      gerenciada: produto.imagem_bling_gerenciada_pelo_orbita,
      desejado: produto.imagem_storage_path,
      confirmado: produto.imagem_bling_sync_path,
    });
    const doBling = !gerenciada && produto.imagem_url?.trim() ? produto.imagem_url : undefined;
    const apresentado: Produto = { ...produto, imagem_url: daFoto ?? doBling };
    if (apresentado.imagem_url === undefined) delete apresentado.imagem_url;
    return apresentado;
  });
}
