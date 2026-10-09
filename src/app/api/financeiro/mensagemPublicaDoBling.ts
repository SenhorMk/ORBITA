import type { BlingProviderFailure } from '@/lib/integrations/bling/pedidoVendaContract';

/**
 * Recusas da requisição por causa dos DADOS enviados. Comparado por
 * pertencimento: o `type` vem do corpo do provedor e nunca é ecoado.
 */
const RECUSA_DE_DADOS: ReadonlySet<string> = new Set([
  'BAD_REQUEST',
  'VALIDATION_ERROR',
  'MISSING_REQUIRED_FIELD_ERROR',
  'EMPTY_REQUEST_BODY',
  'INVALID_REQUEST_BODY',
]);

const RECUSA_DE_ACESSO: ReadonlySet<string> = new Set([
  'INVALID_APIKEY_ERROR',
  'UNAUTHORIZED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
]);

/**
 * Frase pública para uma falha do Bling, em vocabulário fechado do ORBITA.
 *
 * `failure.message` NUNCA entra: `parseBlingFailure` a monta com
 * `description`, `message` e `fields` do provedor — que ecoam o que foi
 * enviado — ou com os primeiros 300 caracteres de um corpo cru (página de
 * proxy, host interno). Publicar isso é CWE-209. Aqui só entram o status, que
 * é número, e a categoria do `type`, decidida por pertencimento a conjuntos
 * fechados.
 *
 * @param failure - A falha tipada do Bling.
 * @param oQue - Trecho em infinitivo, texto do ORBITA ("criar a conta a pagar").
 * @returns A frase que pode ir para a resposta da API.
 */
export function mensagemPublicaDaFalhaDoBling(failure: BlingProviderFailure, oQue: string): string {
  const http = failure.status > 0 ? ` (HTTP ${failure.status})` : '';
  const ehRecusaDoCliente = failure.status >= 400 && failure.status <= 499;

  if (ehRecusaDoCliente && RECUSA_DE_DADOS.has(failure.type)) {
    return `O Bling recusou os dados para ${oQue}${http}. Confira fornecedor, categoria, valor e vencimento.`;
  }
  if (RECUSA_DE_ACESSO.has(failure.type) || failure.status === 401 || failure.status === 403) {
    return `O Bling recusou o acesso necessário para ${oQue}${http}. Reconecte a conta em "Conectar APIs".`;
  }
  if (failure.status === 429) return `O Bling está limitando as requisições${http}, e por isso não deu para ${oQue}.`;
  if (failure.status >= 500) return `O Bling está indisponível${http}, e por isso não deu para ${oQue}.`;
  if (failure.status === 0) return `O Bling não respondeu de forma legível ao ${oQue}.`;
  return `O Bling recusou ${oQue}${http}.`;
}
