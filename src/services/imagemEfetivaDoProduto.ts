import { VALIDADE_DA_LEITURA_ASSINADA_S } from '@/lib/config/produtoImagemContract';
import { registrarFalhaInterna } from '@/lib/observability/falhaInterna';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import type { Produto } from '@/types';

import type { ArmazenamentoDeImagemPort } from './armazenamentoDeImagem';

/**
 * Os produtos como a tela os apresenta: `imagem_url` passa a ser a imagem
 * EFETIVA, com uma precedência só:
 *
 * 1. a foto escolhida no ORBITA (`imagem_storage_path`), por URL assinada;
 * 2. a imagem espelhada do Bling, já persistida em `imagem_url`;
 * 3. nenhuma — a tela desenha o placeholder.
 *
 * Remoção pendente no Bling (`imagem_storage_path` nulo, `imagem_bling_sync_path`
 * preenchido): o espelho do Bling é a foto que está saindo de lá, então não
 * volta para a tela — nem se uma sincronização atrasada regravar `imagem_url`.
 *
 * O caminho persistido segue no objeto, separado: é ele que o formulário usa
 * como precondição ao trocar ou remover a foto. A URL assinada nunca volta ao
 * banco: é gerada aqui, a cada leitura, e expira.
 *
 * As assinaturas saem numa chamada só (`createSignedUrls`). Se o Storage não
 * responder, o catálogo não cai: cada produto mostra a imagem do Bling, e a
 * falha vai para o log com a organização. É apresentação — nenhum dado muda,
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
    const remocaoPendente = !produto.imagem_storage_path && !!produto.imagem_bling_sync_path;
    const doBling = !remocaoPendente && produto.imagem_url?.trim() ? produto.imagem_url : undefined;
    const apresentado: Produto = { ...produto, imagem_url: daFoto ?? doBling };
    if (apresentado.imagem_url === undefined) delete apresentado.imagem_url;
    return apresentado;
  });
}
