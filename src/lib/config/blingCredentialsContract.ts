import { z } from 'zod';

/**
 * Contrato único do corpo de `POST /api/bling/connect` para credenciais do Bling.
 *
 * Existe para que cliente e servidor não divirjam em silêncio sobre a forma das
 * credenciais: se um lado enviasse `{ bling: { clientId, clientSecret } }` e o
 * outro lesse `body.clientId` da raiz, toda tentativa de conectar o Bling
 * falharia com `400`, e testes que constroem cada lado isoladamente não
 * perceberiam.
 *
 * Ambos os lados agora dependem deste módulo: o cliente monta o corpo com
 * `buildBlingCredentialsPayload` e o servidor o valida com
 * `blingCredentialsPayloadSchema`. Uma divergência de forma passa a ser
 * impossível por construção, não apenas improvável.
 */
export const blingCredentialsPayloadSchema = z.object({
  clientId: z.string().min(1, 'Client ID do Bling é obrigatório'),
  clientSecret: z.string().min(1, 'Client Secret do Bling é obrigatório'),
  /**
   * A organização que a tela acreditava estar ativa quando o formulário foi
   * enviado. **Não** é autoridade — ver `organizacaoEsperada.ts`. Opcional
   * porque só recusa, nunca concede.
   */
  organizacaoEsperada: z.string().min(1).optional(),
});

/** Corpo aceito por `POST /api/bling/connect` ao salvar credenciais do Bling. */
export type BlingCredentialsPayload = z.infer<typeof blingCredentialsPayloadSchema>;

/**
 * Forma exata das credenciais do app Bling guardadas cifradas no cofre
 * (`credenciais_integracao.dados_cifrados`).
 *
 * É a segunda fronteira do mesmo dado: `POST /api/bling/connect` escreve e
 * `GET /api/bling/callback` lê. Antes as duas pontas repetiam os nomes das
 * chaves por conta própria (com cast em uma delas), exatamente o arranjo que
 * deixou os tickets 26 e 27 passarem por baixo dos testes. Agora escrita e
 * leitura dependem deste par `buildBlingVaultCredentials`/
 * `blingVaultCredentialsSchema`, então renomear uma chave quebra os dois lados
 * de uma vez.
 */
export const blingVaultCredentialsSchema = z.object({
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
});

/** Credenciais do app Bling no formato persistido pelo cofre de credenciais. */
export type BlingVaultCredentials = z.infer<typeof blingVaultCredentialsSchema>;

/**
 * Converte o corpo recebido da UI para a forma persistida no cofre.
 *
 * @param payload - Credenciais já validadas por `blingCredentialsPayloadSchema`.
 * @returns Objeto cifrado pelo cofre e lido de volta no callback OAuth.
 */
export function buildBlingVaultCredentials(payload: BlingCredentialsPayload): BlingVaultCredentials {
  return {
    client_id: payload.clientId,
    client_secret: payload.clientSecret,
  };
}

/**
 * Monta o corpo da requisição de salvamento de credenciais do Bling.
 *
 * @param clientId - Client ID informado pelo usuário; espaços nas bordas são removidos.
 * @param clientSecret - Client Secret informado pelo usuário; espaços nas bordas são removidos.
 * @param organizacaoEsperada - A organização ativa na tela no momento do envio,
 *   para o servidor recusar a escrita se ela já tiver mudado.
 * @returns Corpo no formato exato que a rota valida.
 */
export function buildBlingCredentialsPayload(
  clientId: string,
  clientSecret: string,
  organizacaoEsperada?: string,
): BlingCredentialsPayload {
  return {
    clientId: clientId.trim(),
    clientSecret: clientSecret.trim(),
    ...(organizacaoEsperada ? { organizacaoEsperada } : {}),
  };
}
