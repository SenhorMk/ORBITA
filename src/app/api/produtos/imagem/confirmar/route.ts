import { dependenciasDaFoto, semVazarFalha } from '../dependencias';
import { createConfirmarUploadHandler } from '../handler';

/** Etapa C: confere o objeto enviado e troca a foto do produto com compare-and-set. */
const confirmarUpload = createConfirmarUploadHandler(dependenciasDaFoto);

export async function POST(request: Request) {
  return semVazarFalha('produtos.imagem.confirmar', () => confirmarUpload(request));
}
