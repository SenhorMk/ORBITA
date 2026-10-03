import { dependenciasDaFoto, semVazarFalha } from '../dependencias';
import { createConfirmarUploadHandler } from '../handler';

/** Etapa C: confere o objeto enviado e troca a foto do produto com compare-and-set. */
const confirmarUpload = createConfirmarUploadHandler(dependenciasDaFoto);

/** A convergência com o Bling espera o processamento assíncrono dele (até 40 s). */
export const maxDuration = 60;

export async function POST(request: Request) {
  return semVazarFalha('produtos.imagem.confirmar', () => confirmarUpload(request));
}
