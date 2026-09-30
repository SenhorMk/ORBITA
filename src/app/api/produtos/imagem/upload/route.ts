import { dependenciasDaFoto, semVazarFalha } from '../dependencias';
import { createAutorizarUploadHandler } from '../handler';

/** Etapa A: autoriza o envio de uma foto para um caminho gerado aqui. O arquivo não passa por esta rota. */
const autorizarUpload = createAutorizarUploadHandler(dependenciasDaFoto);

export async function POST(request: Request) {
  return semVazarFalha('produtos.imagem.upload', () => autorizarUpload(request));
}
