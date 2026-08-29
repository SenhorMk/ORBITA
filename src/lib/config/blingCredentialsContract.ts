import { z } from 'zod';

/**
 * Contrato único do corpo de `POST /api/config` para credenciais do Bling.
 *
 * Existe porque cliente e servidor divergiram silenciosamente: o `SetupWizard`
 * enviava `{ bling: { clientId, clientSecret } }` enquanto a rota lia
 * `body.clientId` da raiz, resultando em `400 "Client ID e Client Secret são
 * obrigatórios"` em toda tentativa de conectar o Bling. Nenhum teste pegou
 * porque os dois lados eram construídos e verificados isoladamente.
 *
 * Ambos os lados agora dependem deste módulo: o cliente monta o corpo com
 * `buildBlingCredentialsPayload` e o servidor o valida com
 * `blingCredentialsPayloadSchema`. Uma divergência de forma passa a ser
 * impossível por construção, não apenas improvável.
 */
export const blingCredentialsPayloadSchema = z.object({
  clientId: z.string().min(1, 'Client ID do Bling é obrigatório'),
  clientSecret: z.string().min(1, 'Client Secret do Bling é obrigatório'),
});

/** Corpo aceito por `POST /api/config` ao salvar credenciais do Bling. */
export type BlingCredentialsPayload = z.infer<typeof blingCredentialsPayloadSchema>;

/**
 * Monta o corpo da requisição de salvamento de credenciais do Bling.
 *
 * @param clientId - Client ID informado pelo usuário; espaços nas bordas são removidos.
 * @param clientSecret - Client Secret informado pelo usuário; espaços nas bordas são removidos.
 * @returns Corpo no formato exato que a rota valida.
 */
export function buildBlingCredentialsPayload(
  clientId: string,
  clientSecret: string,
): BlingCredentialsPayload {
  return {
    clientId: clientId.trim(),
    clientSecret: clientSecret.trim(),
  };
}
