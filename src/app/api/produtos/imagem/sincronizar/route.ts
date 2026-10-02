import { dependenciasDaFoto, semVazarFalha } from '../dependencias';
import { createSincronizarFotoHandler } from '../handler';

/** "Tentar sincronizar novamente": converge o Bling para a foto já armazenada, sem novo upload. */
const sincronizarFoto = createSincronizarFotoHandler(dependenciasDaFoto);

/** A convergência com o Bling espera o processamento assíncrono dele (até 40 s). */
export const maxDuration = 60;

export async function POST(request: Request) {
  return semVazarFalha('produtos.imagem.sincronizar', () => sincronizarFoto(request));
}
