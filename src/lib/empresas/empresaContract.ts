import { z } from 'zod';

/**
 * Contrato das rotas de empresa (`/api/empresas/*`): o que o servidor devolve
 * ao navegador. Dados cadastrais públicos de pessoa jurídica — nunca a chave do
 * provedor, nunca o payload bruto dele.
 */

const textoOpcional = z.string().nullable();

/** O mínimo para escolher uma empresa numa lista de sugestões. */
export const empresaResumoSchema = z.object({
  cnpj: z.string().regex(/^\d{14}$/u),
  razaoSocial: z.string().min(1),
  nomeFantasia: textoOpcional,
  municipio: textoOpcional,
  uf: textoOpcional,
  situacao: textoOpcional,
});
export type EmpresaResumo = z.infer<typeof empresaResumoSchema>;

/** A consulta completa por CNPJ, já no vocabulário do ORBITA. */
export const empresaCompletaSchema = empresaResumoSchema.extend({
  email: textoOpcional,
  telefone: textoOpcional,
  cep: textoOpcional,
  logradouro: textoOpcional,
  numero: textoOpcional,
  bairro: textoOpcional,
});
export type EmpresaCompleta = z.infer<typeof empresaCompletaSchema>;

/** Termo da busca por nome: mínimo 3, máximo 80 caracteres úteis. */
export const TERMO_MINIMO = 3;
export const TERMO_MAXIMO = 80;
/** Sugestões mostradas de uma vez. */
export const MAXIMO_DE_SUGESTOES = 8;

export const respostaDaConsultaPorCnpjSchema = z.discriminatedUnion('resultado', [
  z.object({ resultado: z.literal('EmpresaEncontrada'), empresa: empresaCompletaSchema }),
  z.object({ resultado: z.literal('EmpresaNaoEncontrada') }),
  z.object({ resultado: z.literal('CnpjInvalido') }),
  z.object({ resultado: z.literal('ConsultaIndisponivel') }),
  z.object({ resultado: z.literal('LimiteDeConsultas') }),
]);
export type RespostaDaConsultaPorCnpj = z.infer<typeof respostaDaConsultaPorCnpjSchema>;

export const respostaDaBuscaSchema = z.discriminatedUnion('resultado', [
  z.object({ resultado: z.literal('Empresas'), empresas: z.array(empresaResumoSchema).max(MAXIMO_DE_SUGESTOES) }),
  z.object({ resultado: z.literal('TermoInvalido') }),
  /** Nenhum provedor de busca por nome configurado no servidor: só o modo CNPJ funciona. */
  z.object({ resultado: z.literal('BuscaPorNomeIndisponivel') }),
  z.object({ resultado: z.literal('BuscaIndisponivel') }),
  z.object({ resultado: z.literal('LimiteDeConsultas') }),
]);
export type RespostaDaBusca = z.infer<typeof respostaDaBuscaSchema>;
