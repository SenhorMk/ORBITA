import { z } from 'zod';

/**
 * Contrato de `GET /api/empresas/cnpj/[cnpj]`: o que o servidor devolve ao
 * navegador. Dados cadastrais públicos de pessoa jurídica, já no vocabulário
 * do ORBITA. Nunca o payload bruto do provedor.
 */

const textoOpcional = z.string().nullable();

/** A consulta completa por CNPJ. */
export const empresaCompletaSchema = z.object({
  cnpj: z.string().regex(/^\d{14}$/u),
  razaoSocial: z.string().min(1),
  nomeFantasia: textoOpcional,
  situacao: textoOpcional,
  email: textoOpcional,
  telefone: textoOpcional,
  cep: textoOpcional,
  logradouro: textoOpcional,
  numero: textoOpcional,
  bairro: textoOpcional,
  municipio: textoOpcional,
  uf: textoOpcional,
});
export type EmpresaCompleta = z.infer<typeof empresaCompletaSchema>;

export const respostaDaConsultaPorCnpjSchema = z.discriminatedUnion('resultado', [
  z.object({ resultado: z.literal('EmpresaEncontrada'), empresa: empresaCompletaSchema }),
  z.object({ resultado: z.literal('EmpresaNaoEncontrada') }),
  z.object({ resultado: z.literal('CnpjInvalido') }),
  z.object({ resultado: z.literal('ConsultaIndisponivel') }),
  z.object({ resultado: z.literal('LimiteDeConsultas') }),
  /** Sessão válida, mas sem a capacidade de cadastrar contatos nesta organização. */
  z.object({ resultado: z.literal('SemPermissao') }),
]);
export type RespostaDaConsultaPorCnpj = z.infer<typeof respostaDaConsultaPorCnpjSchema>;
