import { z } from 'zod';

const texto = z.string().trim().min(1).max(4000);
const seletor = {
  acao: z.literal('editar_produtos'),
  selecao: z.enum(['um', 'todos']),
  por: z.enum(['sku', 'nome', 'categoria']),
  referencia: z.string().trim().min(2).max(120),
};

/** Intenção sem autoridade: o servidor resolve os produtos dentro da organização. */
export const pedidoEdicao = z.discriminatedUnion('campo', [
  z.object({ ...seletor, campo: z.literal('estoque'), valor: z.number().int().min(0).max(1_000_000) }).strict(),
  z.object({ ...seletor, campo: z.literal('nome'), valor: texto.max(120) }).strict(),
  z.object({ ...seletor, campo: z.literal('descricao'), valor: texto }).strict(),
]);
/** Pedido de alteração interpretado, ainda sujeito à seleção e confirmação. */
export type PedidoEdicao = z.infer<typeof pedidoEdicao>;

const baseItem = {
  produtoId: z.string().uuid(), blingId: z.string().regex(/^\d{1,15}$/u),
  nome: z.string(), codigo: z.string().nullable(),
};
/** Snapshot do campo remoto exibido na confirmação. */
export const itemEdicao = z.discriminatedUnion('campo', [
  z.object({ ...baseItem, campo: z.literal('estoque'), anterior: z.number(), valor: z.number().int().min(0).max(1_000_000) }).strict(),
  z.object({ ...baseItem, campo: z.literal('nome'), anterior: z.string(), valor: texto.max(120) }).strict(),
  z.object({ ...baseItem, campo: z.literal('descricao'), anterior: z.string(), valor: texto }).strict(),
]);
/** Item cuja identidade e valor foram resolvidos no servidor. */
export type ItemEdicao = z.infer<typeof itemEdicao>;
/** Depósito único verificado no Bling; vários depósitos exigem escolha fora deste fluxo. */
export const depositoEdicao = z.object({ id: z.number().int().positive().safe(), nome: z.string() }).strict();
/** Conteúdo persistido imutável da proposta, sem credenciais. */
export const conteudoEdicao = z.object({
  itens: z.array(itemEdicao).min(1).max(20), deposito: depositoEdicao.nullable(),
}).strict();
/** Proposta vinculada ao ator e organização pela persistência. */
export const propostaEdicao = conteudoEdicao.extend({ chave: z.string().uuid(), expiraEm: z.string().datetime({ offset: true }) });
/** Proposta pronta para exibição no painel. */
export type PropostaEdicao = z.infer<typeof propostaEdicao>;
/** Recibo por produto; indeterminado nunca significa recusa nem sucesso. */
export const resultadoEdicao = z.object({
  produtoId: z.string().uuid(), nome: z.string(),
  estado: z.enum(['aplicado', 'recusado', 'alterado_apos_previa', 'indeterminado', 'nao_enviado']),
}).strict();
/** Resultado durável de uma tentativa, sem texto do provedor. */
export type ResultadoEdicao = z.infer<typeof resultadoEdicao>;
/** Resposta comum à prévia e à confirmação, renderizada como texto no painel. */
export type RespostaEdicao = {
  readonly mensagem: string;
  readonly proposta?: PropostaEdicao;
  readonly resultados?: readonly ResultadoEdicao[];
  readonly emAndamento?: boolean;
};
