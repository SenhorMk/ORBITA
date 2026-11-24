import { z } from 'zod';
import { escolhaEdicao, pedidoEdicao, propostaEdicao, resultadoEdicao } from './edicaoDeProdutosContract';

export const pedidoAssistente = z.object({
  pergunta: z.string().trim().min(4).max(4500),
  organizacaoEsperada: z.string().uuid(),
}).strict();

const data = z.string().date();
const periodo = z.union([
  z.object({ tipo: z.literal('dias'), dias: z.number().int().min(1).max(90) }).strict(),
  z.object({ tipo: z.literal('datas'), inicio: data, fim: data }).strict(),
]);
export type PeriodoAssistente = z.infer<typeof periodo>;
const referencia = z.string().trim().min(1).max(120);
const idPedido = z.string().regex(/^\d{1,18}$/u);

/** A Groq aceita anyOf, emitido por z.union. Cada alternativa tem campos e discriminantes próprios. */
export const ferramentaAssistente = z.union([
  pedidoEdicao,
  z.object({ acao: z.literal('vendas_do_periodo'), periodo }).strict(),
  z.object({ acao: z.literal('produtos_mais_vendidos'), periodo, ordenar: z.enum(['quantidade', 'valor']) }).strict(),
  z.object({ acao: z.literal('consultar_estoque'), referencia }).strict(),
  z.object({ acao: z.literal('estoque_baixo'), limite: z.number().int().min(0).max(50) }).strict(),
  z.object({ acao: z.literal('consultar_pedido'), referencia: idPedido, por: z.enum(['numero', 'bling']) }).strict(),
  z.object({ acao: z.literal('consultar_rastreamento'), referencia: idPedido, por: z.enum(['numero', 'bling']) }).strict(),
  z.object({ acao: z.enum(['sem_fonte_procura', 'esclarecer', 'fora_do_escopo']) }).strict(),
]);

export type FerramentaAssistente = z.infer<typeof ferramentaAssistente>;

/**
 * O esquema ENVIADO à Groq (modo estrito). A Groq recusa um `anyOf` dentro de
 * outro quando as alternativas internas não têm UM campo que as diferencie:
 * `pedidoEdicao` tinha `acao`, `selecao` e `por` iguais nas três e só `campo`
 * mudava ("anyOf disambiguation failed: discriminator: multiple candidate
 * properties"), o que derrubava TODA pergunta ao assistente. Aqui cada edição
 * tem uma `acao` própria no mesmo nível das consultas; `paraFerramentaAssistente`
 * devolve o contrato interno (`editar_produtos` + `campo`), que segue igual.
 */
const seletorDeEdicao = {
  selecao: z.enum(['um', 'todos']),
  por: z.enum(['sku', 'nome', 'categoria']),
  referencia: z.string().trim().min(2).max(120),
};
const textoDeEdicao = z.string().trim().min(1).max(4000);
export const ferramentaDoModelo = z.union([
  z.object({ acao: z.literal('editar_estoque'), ...seletorDeEdicao, valor: z.number().int().min(0).max(1_000_000) }).strict(),
  z.object({ acao: z.literal('editar_nome'), ...seletorDeEdicao, valor: textoDeEdicao.max(120) }).strict(),
  z.object({ acao: z.literal('editar_descricao'), ...seletorDeEdicao, valor: textoDeEdicao }).strict(),
  z.object({ acao: z.literal('vendas_do_periodo'), periodo }).strict(),
  z.object({ acao: z.literal('produtos_mais_vendidos'), periodo, ordenar: z.enum(['quantidade', 'valor']) }).strict(),
  z.object({ acao: z.literal('consultar_estoque'), referencia }).strict(),
  z.object({ acao: z.literal('estoque_baixo'), limite: z.number().int().min(0).max(50) }).strict(),
  z.object({ acao: z.literal('consultar_pedido'), referencia: idPedido, por: z.enum(['numero', 'bling']) }).strict(),
  z.object({ acao: z.literal('consultar_rastreamento'), referencia: idPedido, por: z.enum(['numero', 'bling']) }).strict(),
  z.object({ acao: z.enum(['sem_fonte_procura', 'esclarecer', 'fora_do_escopo']) }).strict(),
]);
export type FerramentaDoModelo = z.infer<typeof ferramentaDoModelo>;

const CAMPO_DA_EDICAO = { editar_estoque: 'estoque', editar_nome: 'nome', editar_descricao: 'descricao' } as const;

/** Converte a escolha do modelo no contrato interno e revalida (falha fechada). */
export function paraFerramentaAssistente(escolha: FerramentaDoModelo): FerramentaAssistente {
  if (escolha.acao === 'editar_estoque' || escolha.acao === 'editar_nome' || escolha.acao === 'editar_descricao') {
    const { acao, ...resto } = escolha;
    return ferramentaAssistente.parse({ acao: 'editar_produtos', campo: CAMPO_DA_EDICAO[acao], ...resto });
  }
  return ferramentaAssistente.parse(escolha);
}
/** Resposta parseada também no navegador antes de mostrar uma confirmação. */
export const respostaAssistenteSchema = z.object({
  mensagem: z.string(), fonte: z.string().optional(), detalhes: z.array(z.string()).readonly().optional(),
  proposta: propostaEdicao.optional(), resultados: z.array(resultadoEdicao).readonly().optional(),
  emAndamento: z.boolean().optional(), escolha: escolhaEdicao.optional(),
}).strict();
/** Resposta de consulta, prévia ou recibo do assistente autenticado. */
export type RespostaAssistente = z.infer<typeof respostaAssistenteSchema>;
