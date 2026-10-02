import { z } from 'zod';

import bucket from './produtoImagemBucket.json';

/**
 * Contrato único da foto do produto, importado pelo navegador e pelo servidor.
 *
 * A foto é uma propriedade LOCAL do ORBITA: fica no bucket privado
 * `produto-imagens` e o banco guarda só o caminho do objeto, em
 * `produtos.imagem_storage_path` (migration 70). `imagem_url` continua sendo o
 * espelho do Bling, que a sincronização regrava.
 *
 * O arquivo nunca passa pelo servidor do ORBITA. São três etapas:
 *
 * 1. `POST /api/produtos/imagem/upload` — o servidor confere quem pede, o
 *    produto e o tipo/tamanho declarados, **gera o caminho** e devolve um token
 *    de upload assinado só para ele;
 * 2. o navegador envia direto ao Storage com `uploadToSignedUrl`;
 * 3. `POST /api/produtos/imagem/confirmar` — o servidor confere que o objeto
 *    existe e troca o caminho no produto com compare-and-set.
 *
 * A configuração do bucket vive em `produtoImagemBucket.json` porque o script
 * de provisionamento (`scripts/storage-bucket-produto-imagens.mjs`) lê o mesmo
 * arquivo: tipos e limite são uma fonte só.
 */

export const BUCKET_PRODUTO_IMAGENS: string = bucket.id;

export const TIPOS_DE_IMAGEM = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type TipoDeImagem = (typeof TIPOS_DE_IMAGEM)[number];

/**
 * 3 MB — o limite por imagem do Bling (central de ajuda oficial), já que a
 * foto do ORBITA é importada lá. Fonte única: `produtoImagemBucket.json`, que
 * o bucket também impõe; conferir aqui é só antecipar a recusa.
 */
export const TAMANHO_MAXIMO_DA_IMAGEM: number = bucket.fileSizeLimit;

/** O limite em MB inteiros, para as frases da tela e da API. */
export const TAMANHO_MAXIMO_DA_IMAGEM_MB = Math.round(TAMANHO_MAXIMO_DA_IMAGEM / (1024 * 1024));

/** Para o `accept` do `<input type="file">`. É conveniência de UX, nunca a barreira. */
export const ACCEPT_DE_IMAGEM = TIPOS_DE_IMAGEM.join(',');

const EXTENSAO_POR_TIPO: Readonly<Record<TipoDeImagem, 'jpg' | 'png' | 'webp'>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/** Validade da URL de leitura gerada a cada leitura do catálogo, em segundos. */
export const VALIDADE_DA_LEITURA_ASSINADA_S = 60 * 60;

/**
 * Validade da URL assinada entregue ao Bling para importar a foto. O Bling
 * copia o arquivo para o próprio armazenamento em segundos (provado em
 * 2026-10-02) e não depende da URL depois; a margem cobre a fila dele.
 */
export const VALIDADE_DA_IMPORTACAO_NO_BLING_S = 15 * 60;

/**
 * Validade do lease por produto da sincronização com o Bling.
 *
 * Precisa exceder todo o período em que uma execução antiga ainda pode tocar
 * o Bling: o orçamento da convergência é de 40 s e a função da rota morre em
 * `maxDuration = 60` s. Com 90 s, um lease só expira depois que a execução que
 * o adquiriu já não existe — e só então outra pode recuperá-lo.
 */
export const VALIDADE_DO_LEASE_DA_SINCRONIZACAO_S = 90;

/**
 * O estado da foto do ORBITA no Bling, derivado do par persistido
 * desejado (`imagem_storage_path`) × confirmado (`imagem_bling_sync_path`):
 *
 * - `sem_foto`: o ORBITA nunca adotou a imagem do produto — o Bling é dono;
 * - `sincronizada`: o Bling tem exatamente a foto desejada (ou nenhuma, depois de uma remoção);
 * - `pendente`: o desejado ainda não foi confirmado no Bling;
 * - `sem_vinculo`: há algo a refletir, mas o produto não tem `bling_id`;
 * - `em_andamento`: só na resposta — outra execução detém o lease do produto e
 *   está convergindo o Bling; esta não tocou nele.
 */
export const ESTADOS_DA_FOTO_NO_BLING = ['sem_foto', 'sincronizada', 'pendente', 'sem_vinculo', 'em_andamento'] as const;
export type EstadoDaFotoNoBling = (typeof ESTADOS_DA_FOTO_NO_BLING)[number];

/** A mesma derivação no servidor e na tela. `blingId` só vale quando numérico. */
export function estadoDaFotoNoBling(produto: {
  readonly blingId: string | null | undefined;
  readonly desejado: string | null | undefined;
  readonly confirmado: string | null | undefined;
}): EstadoDaFotoNoBling {
  const desejado = produto.desejado ?? null;
  const confirmado = produto.confirmado ?? null;
  if (desejado === null && confirmado === null) return 'sem_foto';
  if (desejado === confirmado) return 'sincronizada';
  return /^\d+$/u.test(String(produto.blingId ?? '').trim()) ? 'pendente' : 'sem_vinculo';
}

export function tipoDeImagemPermitido(tipo: string): tipo is TipoDeImagem {
  return (TIPOS_DE_IMAGEM as readonly string[]).includes(tipo);
}

export type ProblemaDoArquivo = 'TipoNaoPermitido' | 'ArquivoGrandeDemais';

/** Tipo e tamanho — a mesma regra no navegador (UX) e no servidor. */
export function problemaDoArquivo(tipo: string, tamanho: number): ProblemaDoArquivo | null {
  if (!tipoDeImagemPermitido(tipo)) return 'TipoNaoPermitido';
  if (tamanho > TAMANHO_MAXIMO_DA_IMAGEM) return 'ArquivoGrandeDemais';
  return null;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/**
 * `<organizacao>/<produto>/<uuid>.<ext>`. Só o servidor chama isto, com a
 * organização do escopo verificado e o id do produto relido do banco. É o
 * mesmo formato que `chk_produto_imagem_storage_path` exige.
 */
export function caminhoDaImagem(organizacaoId: string, produtoId: string, objetoId: string, tipo: TipoDeImagem): string {
  return `${organizacaoId.toLowerCase()}/${produtoId.toLowerCase()}/${objetoId.toLowerCase()}.${EXTENSAO_POR_TIPO[tipo]}`;
}

/**
 * O caminho está dentro do prefixo deste produto, nesta organização?
 *
 * Tudo o que chega do navegador com cara de caminho passa por aqui antes de
 * ser gravado ou apagado: nenhum caminho de outro tenant ou de outro produto
 * chega ao banco nem ao `remove` do Storage.
 */
export function caminhoPertenceAoProduto(caminho: string, organizacaoId: string, produtoId: string): boolean {
  const prefixo = `${organizacaoId.toLowerCase()}/${produtoId.toLowerCase()}/`;
  return new RegExp(`^${UUID}/${UUID}/${UUID}\\.(jpg|png|webp)$`, 'u').test(caminho) && caminho.startsWith(prefixo);
}

/** O tipo que a extensão do caminho promete. */
export function tipoDoCaminho(caminho: string): TipoDeImagem | null {
  const extensao = caminho.slice(caminho.lastIndexOf('.') + 1);
  const achado = TIPOS_DE_IMAGEM.find((tipo) => EXTENSAO_POR_TIPO[tipo] === extensao);
  return achado ?? null;
}

// Corpos das requisições. `z.object` descarta chave desconhecida: um `organizationId`, `organizacao_id`
// ou `caminho` mandado na autorização de upload simplesmente não existe para o
// servidor.

const caminhoRecebido = z.string().min(1).max(300);

export const pedidoDeUploadSchema = z.object({
  produtoId: z.string().uuid(),
  tipo: z.string().min(1).max(100),
  tamanho: z.number().int().positive(),
});
export type PedidoDeUpload = z.infer<typeof pedidoDeUploadSchema>;

export const confirmacaoDeUploadSchema = z.object({
  produtoId: z.string().uuid(),
  caminho: caminhoRecebido,
  /**
   * O caminho que o navegador viu como atual. É a precondição do
   * compare-and-set — não autoriza nada: se não for o valor do banco, a troca
   * não acontece.
   */
  anterior: caminhoRecebido.nullable(),
});
export type ConfirmacaoDeUpload = z.infer<typeof confirmacaoDeUploadSchema>;

export const remocaoDeImagemSchema = z.object({
  produtoId: z.string().uuid(),
  anterior: caminhoRecebido,
});
export type RemocaoDeImagem = z.infer<typeof remocaoDeImagemSchema>;

/** `POST /api/produtos/imagem/sincronizar`: só o produto — a foto vem do banco. */
export const sincronizacaoDeImagemSchema = z.object({ produtoId: z.string().uuid() });

const estadoDaFotoNoBlingSchema = z.enum(ESTADOS_DA_FOTO_NO_BLING);

export const respostaDeImagemSchema = z.discriminatedUnion('resultado', [
  z.object({ resultado: z.literal('UploadAutorizado'), caminho: z.string(), token: z.string() }),
  /** `bling`: onde a sincronização com o Bling parou. Falha lá não desfaz a foto local. */
  z.object({ resultado: z.literal('ImagemConfirmada'), caminho: z.string(), url: z.string().nullable(), bling: estadoDaFotoNoBlingSchema }),
  /** `url` é a imagem do Bling que volta a valer, quando existe. */
  z.object({ resultado: z.literal('ImagemRemovida'), url: z.string().nullable(), bling: estadoDaFotoNoBlingSchema }),
  z.object({ resultado: z.literal('SincronizacaoDaFoto'), bling: estadoDaFotoNoBlingSchema }),
  z.object({ resultado: z.literal('TipoNaoPermitido') }),
  z.object({ resultado: z.literal('ArquivoGrandeDemais') }),
  z.object({ resultado: z.literal('ProdutoNaoEncontrado') }),
  z.object({ resultado: z.literal('Conflito') }),
  z.object({ resultado: z.literal('UploadAusente') }),
  z.object({ resultado: z.literal('CaminhoInvalido') }),
  z.object({ resultado: z.literal('RequisicaoInvalida') }),
  z.object({ resultado: z.literal('ArmazenamentoIndisponivel') }),
]);
export type RespostaDeImagem = z.infer<typeof respostaDeImagemSchema>;
export type FalhaDeImagem = Exclude<
  RespostaDeImagem['resultado'],
  'UploadAutorizado' | 'ImagemConfirmada' | 'ImagemRemovida' | 'SincronizacaoDaFoto'
>;

export const STATUS_HTTP_DA_IMAGEM: Readonly<Record<RespostaDeImagem['resultado'], number>> = {
  UploadAutorizado: 200,
  ImagemConfirmada: 200,
  ImagemRemovida: 200,
  SincronizacaoDaFoto: 200,
  TipoNaoPermitido: 415,
  ArquivoGrandeDemais: 413,
  // Inexistente e de outra organização são a MESMA resposta: a diferença
  // confirmaria a existência de um produto que não é de quem pergunta.
  ProdutoNaoEncontrado: 404,
  Conflito: 409,
  UploadAusente: 422,
  CaminhoInvalido: 400,
  RequisicaoInvalida: 400,
  ArmazenamentoIndisponivel: 503,
};

/** Frases públicas. Nenhuma carrega texto do Storage nem detalhe do servidor. */
export const MENSAGEM_DA_FALHA_DE_IMAGEM: Readonly<Record<FalhaDeImagem, string>> = {
  TipoNaoPermitido: 'Formato não suportado. Use uma imagem JPEG, PNG ou WebP.',
  ArquivoGrandeDemais: `A imagem passa de ${TAMANHO_MAXIMO_DA_IMAGEM_MB} MB. Escolha um arquivo menor.`,
  ProdutoNaoEncontrado: 'Produto não encontrado.',
  Conflito: 'A foto deste produto foi alterada em outra janela. Feche e abra o produto de novo para ver a versão atual.',
  UploadAusente: 'O envio da imagem não foi concluído. Tente de novo.',
  CaminhoInvalido: 'Requisição inválida.',
  RequisicaoInvalida: 'Requisição inválida.',
  ArmazenamentoIndisponivel: 'O armazenamento de imagens está indisponível no momento. Tente de novo em instantes.',
};
