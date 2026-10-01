import {
  MENSAGEM_DA_FALHA_DE_IMAGEM,
  problemaDoArquivo,
  respostaDeImagemSchema,
  type FalhaDeImagem,
  type RespostaDeImagem,
} from '@/lib/config/produtoImagemContract';

/**
 * O lado do navegador da foto do produto: as três etapas em sequência, e o
 * desfecho já traduzido para a tela.
 *
 * O arquivo vai do navegador direto ao Storage, com o token que o servidor
 * emitiu para um caminho que o servidor escolheu. Nenhuma rota do ORBITA
 * recebe os bytes. O nome do arquivo não sai daqui.
 */
export interface OperacoesDeFoto {
  /** `POST` autenticado numa rota do ORBITA. */
  postar(url: string, corpo: unknown): Promise<{ readonly status: number; readonly corpo: unknown }>;
  /** `uploadToSignedUrl` do Storage. `true` quando o objeto foi aceito. */
  enviarAoStorage(caminho: string, token: string, arquivo: File): Promise<boolean>;
}

export type DesfechoDaFoto =
  | { readonly _tag: 'Alterada'; readonly caminho: string | null; readonly url: string | null }
  | { readonly _tag: 'Falhou'; readonly mensagem: string; readonly conflito: boolean };

const FALHA_NO_ENVIO = 'Não foi possível enviar a imagem. Tente de novo.';

/**
 * Qualquer resposta fora do contrato — 401/403/503 da autorização, 500 com a
 * frase fixa — vira uma frase pela situação, sem ecoar o corpo.
 */
function falhaForaDoContrato(status: number): DesfechoDaFoto {
  const mensagem = status === 401
    ? 'Sua sessão expirou. Entre novamente para continuar.'
    : status === 403
      ? 'Apenas quem administra a organização pode alterar a foto do produto.'
      : 'Não foi possível concluir agora. Tente de novo em instantes.';
  return { _tag: 'Falhou', mensagem, conflito: false };
}

function lerResposta(resposta: { status: number; corpo: unknown }): RespostaDeImagem | DesfechoDaFoto {
  const lida = respostaDeImagemSchema.safeParse(resposta.corpo);
  return lida.success ? lida.data : falhaForaDoContrato(resposta.status);
}

function ehFalha(resultado: RespostaDeImagem['resultado']): resultado is FalhaDeImagem {
  return Object.hasOwn(MENSAGEM_DA_FALHA_DE_IMAGEM, resultado);
}

/** Um sucesso fora de etapa (ex.: `ImagemRemovida` em resposta ao upload) também é falha. */
function comoFalha(resposta: RespostaDeImagem | DesfechoDaFoto): DesfechoDaFoto {
  if ('_tag' in resposta) return resposta;
  if (!ehFalha(resposta.resultado)) return { _tag: 'Falhou', mensagem: FALHA_NO_ENVIO, conflito: false };
  return {
    _tag: 'Falhou',
    mensagem: MENSAGEM_DA_FALHA_DE_IMAGEM[resposta.resultado],
    conflito: resposta.resultado === 'Conflito',
  };
}

/** Adiciona (sem `anterior`) ou troca (com `anterior`) a foto de um produto já salvo. */
export async function enviarFoto(
  arquivo: File,
  alvo: { readonly produtoId: string; readonly anterior: string | null },
  operacoes: OperacoesDeFoto,
): Promise<DesfechoDaFoto> {
  // Antecipa a recusa para não gastar um envio. O servidor e o bucket
  // conferem de novo — isto é UX, não barreira.
  const problema = problemaDoArquivo(arquivo.type, arquivo.size);
  if (problema !== null) return { _tag: 'Falhou', mensagem: MENSAGEM_DA_FALHA_DE_IMAGEM[problema], conflito: false };

  const autorizacao = lerResposta(await operacoes.postar('/api/produtos/imagem/upload', {
    produtoId: alvo.produtoId,
    tipo: arquivo.type,
    tamanho: arquivo.size,
  }));
  if ('_tag' in autorizacao || autorizacao.resultado !== 'UploadAutorizado') return comoFalha(autorizacao);

  const enviado = await operacoes.enviarAoStorage(autorizacao.caminho, autorizacao.token, arquivo);
  if (!enviado) return { _tag: 'Falhou', mensagem: FALHA_NO_ENVIO, conflito: false };

  const confirmacao = lerResposta(await operacoes.postar('/api/produtos/imagem/confirmar', {
    produtoId: alvo.produtoId,
    caminho: autorizacao.caminho,
    anterior: alvo.anterior,
  }));
  if ('_tag' in confirmacao || confirmacao.resultado !== 'ImagemConfirmada') return comoFalha(confirmacao);
  return { _tag: 'Alterada', caminho: confirmacao.caminho, url: confirmacao.url };
}

/** Remove a foto do ORBITA; `url` volta como a imagem do Bling, quando há. */
export async function removerFoto(
  alvo: { readonly produtoId: string; readonly anterior: string },
  operacoes: OperacoesDeFoto,
): Promise<DesfechoDaFoto> {
  const resposta = lerResposta(await operacoes.postar('/api/produtos/imagem/remover', alvo));
  if ('_tag' in resposta || resposta.resultado !== 'ImagemRemovida') return comoFalha(resposta);
  return { _tag: 'Alterada', caminho: null, url: resposta.url };
}
