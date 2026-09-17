import { z } from 'zod';

/**
 * Contrato do recurso `POST /pedidos/vendas` da API v3 do Bling.
 *
 * A autoridade deste arquivo é o documento OpenAPI **oficial** publicado pelo
 * Bling e carregado pelo próprio portal de referência:
 *
 *   https://developer.bling.com.br/build/assets/openapi-BvBfsn8J.json
 *
 * (o portal `developer.bling.com.br/referencia` é uma SPA Swagger UI; o módulo
 * `build/assets/reference-*.js` instancia o Swagger com essa URL, que responde
 * `200 application/json` sem autenticação — ver
 * `docs/integrations/bling-v3-contract.md`).
 *
 * Os schemas Zod daqui funcionam nos dois sentidos da fronteira com o Bling:
 * - **saída**: o payload do pedido é validado antes do envio, então o adapter
 *   só manda ao ERP o que o contrato oficial aceita, e um campo faltando vira
 *   mensagem clara em vez de um `400` opaco do provedor;
 * - **entrada**: a resposta de criação e o corpo de erro do Bling também são
 *   validados, em vez de confiar na forma que o fornecedor deveria mandar.
 */

/** `data`, `dataPrevista`, `dataSaida` e `parcelas[].dataVencimento` usam `format: date`. */
const blingDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u, 'Data do Bling deve estar no formato AAAA-MM-DD');

/**
 * `itens[]`: obrigatórios `quantidade`, `valor`, `valorLista` e `descricao`
 * (`id` é `readOnly` e ignorado no POST). `produto.id` é obrigatório quando
 * `produto` é enviado, e a v3 valida o produto por ID — um item apenas com
 * `codigo` é recusado.
 */
export const pedidoVendaItemSchema = z.object({
  descricao: z.string().min(1, 'Descrição do item é obrigatória'),
  quantidade: z.number().positive('Quantidade do item deve ser maior que zero'),
  valor: z.number().nonnegative(),
  valorLista: z.number().nonnegative(),
  codigo: z.string().min(1).optional(),
  unidade: z.string().min(1).optional(),
  produto: z.object({ id: z.number().int().positive() }),
});

/** `parcelas[]`: obrigatórios `dataVencimento`, `valor` e `formaPagamento.id`. */
export const pedidoVendaParcelaSchema = z.object({
  dataVencimento: blingDateSchema,
  valor: z.number().nonnegative(),
  observacoes: z.string().optional(),
  formaPagamento: z.object({ id: z.number().int().positive() }),
});

/**
 * Corpo aceito por `POST /pedidos/vendas`.
 *
 * Obrigatórios segundo o OpenAPI oficial: `contato`, `data`, `dataPrevista`,
 * `dataSaida`, `itens` e `parcelas`. `total` e `totalProdutos` são `readOnly`
 * — o Bling os calcula e **não** aceita o valor do cliente, por isso não
 * aparecem aqui.
 *
 * `situacao` é deliberadamente omitido: os ids de situação são por conta
 * (`GET /situacoes/modulos/{idModuloSistema}`), então fixar um número no
 * código inventa um valor que pode não existir na conta do proprietário.
 * Sem `situacao`, o Bling aplica a situação padrão da própria conta.
 */
export const pedidoVendaPayloadSchema = z.object({
  contato: z.object({ id: z.number().int().positive() }),
  data: blingDateSchema,
  dataPrevista: blingDateSchema,
  dataSaida: blingDateSchema,
  itens: z.array(pedidoVendaItemSchema).min(1, 'O pedido precisa de ao menos um item'),
  parcelas: z.array(pedidoVendaParcelaSchema).min(1, 'O pedido precisa de ao menos uma parcela'),
  numeroLoja: z.string().min(1).optional(),
  observacoes: z.string().min(1).optional(),
  desconto: z
    .object({ valor: z.number().nonnegative(), unidade: z.enum(['REAL', 'PERCENTUAL']).default('REAL') })
    .optional(),
  transporte: z
    .object({ frete: z.number().nonnegative(), fretePorConta: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(9)]).optional() })
    .optional(),
});

export type PedidoVendaPayload = z.infer<typeof pedidoVendaPayloadSchema>;

/**
 * Resposta `201` de `POST /pedidos/vendas`.
 *
 * O Bling devolve **apenas** `data.id` (mais `alertas` e `rastreamento`
 * opcionais). Não existe `data.numero` na resposta de criação — o código
 * anterior lia esse campo e caía num fallback silencioso porque ele é sempre
 * `undefined`. Quem precisa do número do pedido tem de buscá-lo depois.
 */
export const pedidoVendaCreatedSchema = z.object({
  data: z.object({
    id: z.union([z.number(), z.string()]).transform((value) => String(value)),
    alertas: z
      .array(z.object({ code: z.number().optional(), msg: z.string() }))
      .optional(),
  }),
});

/** Um dos motivos de erro enumerados em `error.type` pela API v3. */
export const blingErrorTypeSchema = z.enum([
  'BAD_REQUEST',
  'VALIDATION_ERROR',
  'MISSING_REQUIRED_FIELD_ERROR',
  'EMPTY_REQUEST_BODY',
  'INVALID_REQUEST_BODY',
  'INVALID_APIKEY_ERROR',
  'UNAUTHORIZED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'RESOURCE_NOT_FOUND',
  'METHOD_NOT_ALLOWED',
  'TOO_MANY_REQUESTS',
  'UNKNOWN_ERROR',
  'SERVER_ERROR',
  'NOT_IMPLEMENTED',
]);

/**
 * Corpo de erro da API v3. É estruturado — jogar `response.text()` cru na tela
 * do usuário, como o código anterior fazia, esconde `description` e a lista de
 * campos inválidos dentro de um JSON ilegível.
 */
export const blingErrorBodySchema = z.object({
  error: z.object({
    type: blingErrorTypeSchema.or(z.string()),
    message: z.string().optional(),
    description: z.string().optional(),
    fields: z
      .array(
        z.object({
          code: z.number().optional(),
          msg: z.string(),
          element: z.string().optional(),
          namespace: z.string().optional(),
        }),
      )
      .optional(),
  }),
});

export type BlingErrorBody = z.infer<typeof blingErrorBodySchema>;

/**
 * Código que o Bling usa para recusar uma venda idêntica à última salva.
 * O modal tentava detectar essa recusa comparando a mensagem por substring,
 * com os escapes `ç` gravados literalmente no fonte — comparação que
 * nunca casava. O código estruturado é a chave estável.
 */
export const BLING_DUPLICATE_SALE_FIELD_CODE = 3;

/**
 * Resultado de uma chamada ao Bling.
 *
 * Vive no contrato, e não na rota, para que o adapter de produção
 * (`src/services/bling.ts`) possa devolvê-lo sem que a camada de serviço
 * precise importar nada de `src/app` — o verificador de limites do monólito
 * proíbe essa direção.
 */
export type BlingCallResult<T> =
  | { readonly _tag: 'BlingOk'; readonly value: T }
  | { readonly _tag: 'BlingFailed'; readonly failure: BlingProviderFailure };

/**
 * Resultado de procurar um pedido de venda pela referência local
 * (`numeroLoja`).
 *
 * A **cardinalidade é explícita** porque cada caso exige uma reação diferente,
 * e "pegar o primeiro" seria escolher em silêncio: com mais de um pedido
 * carregando a mesma referência, associar a tentativa a qualquer um deles é um
 * palpite, e o palpite errado conclui uma venda com o pedido errado.
 */
export type BuscaDePedidoPorNumeroLoja =
  | { readonly _tag: 'NenhumPedido' }
  | { readonly _tag: 'UmPedido'; readonly pedido: { readonly id: string; readonly numeroLoja: string; readonly situacao: string | null } }
  | { readonly _tag: 'VariosPedidos'; readonly quantidade: number; readonly ids: readonly string[] };

/** Falha do provedor já traduzida para algo que pode ser mostrado ao usuário. */
export interface BlingProviderFailure {
  readonly _tag: 'BlingProviderFailure';
  /** `error.type` quando o corpo é o envelope padrão da v3; `HTTP_<status>` quando não é. */
  readonly type: string;
  readonly status: number;
  /** Mensagem pronta para a UI, já sem JSON cru. */
  readonly message: string;
  /** `true` quando o Bling recusou por venda idêntica à anterior. */
  readonly duplicateSale: boolean;
}

/**
 * Falha tipada montada pelo próprio ORBITA, para os casos em que o problema
 * não vem do envelope de erro do Bling — resposta de sucesso sem os dados
 * prometidos, ou recurso que a conta não tem configurado.
 */
export function blingFailure(type: string, status: number, message: string): BlingCallResult<never> {
  return {
    _tag: 'BlingFailed',
    failure: { _tag: 'BlingProviderFailure', type, status, message, duplicateSale: false },
  };
}

/**
 * Traduz o corpo de erro do Bling em uma falha tipada e legível.
 *
 * Aceita o corpo já como texto porque é assim que ele chega do `fetch` quando
 * a resposta não é `ok` — e porque nem todo erro do Bling é JSON.
 */
export function parseBlingFailure(status: number, rawBody: string): BlingProviderFailure {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawBody);
  } catch {
    parsedJson = undefined;
  }

  const envelope = blingErrorBodySchema.safeParse(parsedJson);
  if (!envelope.success) {
    const trimmed = rawBody.trim();
    return {
      _tag: 'BlingProviderFailure',
      type: `HTTP_${status}`,
      status,
      message: trimmed.length > 0 && trimmed.length <= 300 ? trimmed : `O Bling recusou a requisição (HTTP ${status}).`,
      duplicateSale: false,
    };
  }

  const { type, description, message, fields } = envelope.data.error;
  const duplicateSale = (fields ?? []).some((field) => field.code === BLING_DUPLICATE_SALE_FIELD_CODE);
  const fieldMessages = (fields ?? []).map((field) => (field.element ? `${field.element}: ${field.msg}` : field.msg));
  const headline = description ?? message ?? `O Bling recusou a requisição (${type}).`;

  return {
    _tag: 'BlingProviderFailure',
    type,
    status,
    message: fieldMessages.length > 0 ? `${headline} (${fieldMessages.join('; ')})` : headline,
    duplicateSale,
  };
}
