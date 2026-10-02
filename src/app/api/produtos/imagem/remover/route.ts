import { dependenciasDaFoto, semVazarFalha } from '../dependencias';
import { createRemoverImagemHandler } from '../handler';

/** Remove a foto do ORBITA. A imagem do Bling não é tocada e volta a ser exibida. */
const removerImagem = createRemoverImagemHandler(dependenciasDaFoto);

/** A convergência com o Bling espera o processamento assíncrono dele (até 40 s). */
export const maxDuration = 60;

export async function POST(request: Request) {
  return semVazarFalha('produtos.imagem.remover', () => removerImagem(request));
}
