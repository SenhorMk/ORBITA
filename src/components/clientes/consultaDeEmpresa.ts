import { cnpjValido, digitosDoDocumento, formatarCnpj } from '@/lib/documento';
import {
  respostaDaConsultaPorCnpjSchema,
  type EmpresaCompleta,
  type RespostaDaConsultaPorCnpj,
} from '@/lib/empresas/empresaContract';

/**
 * O lado do navegador da consulta por CNPJ: a chamada à rota do ORBITA e a
 * regra de preenchimento do formulário de contato. Nada aqui grava: preencher
 * é só sugerir; quem salva é "Salvar contato", pelo fluxo de sempre.
 */

/** `fetch` autenticado (`fetchWithAuth`), o mesmo do resto da tela. */
export type BuscaAutenticada = (url: string, opcoes?: RequestInit) => Promise<Response>;

/** O que fazer com o que a pessoa digitou no campo de consulta. */
export type Intencao =
  | { readonly _tag: 'Vazio' }
  /** Só dígitos e pontuação de CNPJ, ainda sem os 14 dígitos: espera. */
  | { readonly _tag: 'Incompleto' }
  /** 14 dígitos (ou mais) que não formam um CNPJ válido: não consulta. */
  | { readonly _tag: 'CnpjInvalido' }
  /** Letras ou outros caracteres: a consulta é só por CNPJ. */
  | { readonly _tag: 'NaoCnpj' }
  | { readonly _tag: 'Cnpj'; readonly cnpj: string };

export function intencaoDaConsulta(texto: string): Intencao {
  const limpo = texto.trim();
  if (limpo === '') return { _tag: 'Vazio' };
  if (!/^[\d./\-\s]+$/u.test(limpo)) return { _tag: 'NaoCnpj' };
  const digitos = digitosDoDocumento(limpo);
  if (digitos.length < 14) return { _tag: 'Incompleto' };
  return cnpjValido(digitos) ? { _tag: 'Cnpj', cnpj: digitos } : { _tag: 'CnpjInvalido' };
}

async function lerJson(resposta: Response): Promise<unknown> {
  try {
    return await resposta.json();
  } catch {
    return null;
  }
}

/**
 * Consulta a rota do ORBITA. Resposta fora do contrato, ou de outra empresa
 * que não a pedida, vira "indisponível": nunca eco do corpo, nunca dado de
 * um CNPJ diferente.
 */
export async function consultarCnpj(cnpj: string, buscar: BuscaAutenticada, sinal?: AbortSignal): Promise<RespostaDaConsultaPorCnpj> {
  const pedido = digitosDoDocumento(cnpj);
  const resposta = await buscar(`/api/empresas/cnpj/${pedido}`, { signal: sinal });
  const lido = respostaDaConsultaPorCnpjSchema.safeParse(await lerJson(resposta));
  if (!lido.success) return { resultado: 'ConsultaIndisponivel' };
  if (lido.data.resultado === 'EmpresaEncontrada' && lido.data.empresa.cnpj !== pedido) return { resultado: 'ConsultaIndisponivel' };
  return lido.data;
}

/** Os campos do formulário de contato que a consulta preenche. `tipo` é decidido à parte. */
export const CAMPOS_PREENCHIDOS = ['nome', 'cpfCnpj', 'email', 'telefone', 'cep', 'endereco', 'numero', 'bairro', 'cidade', 'uf'] as const;
export type CampoPreenchido = (typeof CAMPOS_PREENCHIDOS)[number];
export type ValoresDoFormulario = Record<CampoPreenchido, string>;

export const ROTULO_DO_CAMPO: Record<CampoPreenchido, string> = {
  nome: 'Nome',
  cpfCnpj: 'CPF/CNPJ',
  email: 'E-mail',
  telefone: 'Telefone',
  cep: 'CEP',
  endereco: 'Endereço',
  numero: 'Número',
  bairro: 'Bairro',
  cidade: 'Cidade',
  uf: 'UF',
};

/** A empresa nos campos do formulário de contato. `nome` é a razão social oficial. */
export function valoresDaEmpresa(empresa: EmpresaCompleta): ValoresDoFormulario {
  return {
    nome: empresa.razaoSocial,
    cpfCnpj: formatarCnpj(empresa.cnpj),
    email: empresa.email ?? '',
    telefone: empresa.telefone ?? '',
    cep: empresa.cep ?? '',
    endereco: empresa.logradouro ?? '',
    numero: empresa.numero ?? '',
    bairro: empresa.bairro ?? '',
    cidade: empresa.municipio ?? '',
    uf: empresa.uf ?? '',
  };
}

export interface ResultadoDoPreenchimento {
  readonly valores: ValoresDoFormulario;
  /** O que a consulta pôs em cada campo, para a próxima consulta saber o que é dela. */
  readonly daBusca: ValoresDoFormulario;
  /** Campos que a pessoa tinha preenchido com outro valor e ficaram como estavam. */
  readonly mantidos: readonly CampoPreenchido[];
  /** O documento que a pessoa tinha digitado e que o CNPJ consultado substituiu. */
  readonly documentoSubstituido: string | null;
}

/**
 * Preenche sem atropelar quem digitou, e sem deixar o cadastro com duas
 * identidades.
 *
 * - **CPF/CNPJ recebe sempre o CNPJ consultado.** Ele identifica a empresa:
 *   manter um documento digitado antes, com o resto vindo de outra empresa,
 *   gravaria um cadastro contraditório. Se a pessoa tinha digitado outro
 *   documento, ele volta em `documentoSubstituido` para a tela dizer isso.
 * - Os demais campos são da PESSOA quando têm valor e esse valor não é o que a
 *   consulta anterior colocou lá. Esses ficam como estão e voltam em
 *   `mantidos`. Os outros (vazios, ou ainda com o valor de uma consulta
 *   anterior) recebem o da empresa nova: consultar outra empresa troca o que
 *   a consulta tinha posto.
 */
export function preencherComEmpresa(
  atuais: ValoresDoFormulario,
  daBuscaAnterior: Partial<ValoresDoFormulario>,
  empresa: EmpresaCompleta,
): ResultadoDoPreenchimento {
  const encontrados = valoresDaEmpresa(empresa);
  const valores = { ...atuais };
  const mantidos: CampoPreenchido[] = [];
  const editadoPelaPessoa = (campo: CampoPreenchido) => {
    const atual = atuais[campo].trim();
    return atual !== '' && atual !== (daBuscaAnterior[campo] ?? '').trim();
  };

  for (const campo of CAMPOS_PREENCHIDOS) {
    if (campo === 'cpfCnpj') continue;
    if (editadoPelaPessoa(campo)) {
      if (atuais[campo].trim() !== encontrados[campo].trim()) mantidos.push(campo);
      continue;
    }
    valores[campo] = encontrados[campo];
  }

  const documentoAnterior = atuais.cpfCnpj.trim();
  const documentoSubstituido = editadoPelaPessoa('cpfCnpj') && digitosDoDocumento(documentoAnterior) !== empresa.cnpj
    ? documentoAnterior
    : null;
  valores.cpfCnpj = encontrados.cpfCnpj;

  return { valores, daBusca: encontrados, mantidos, documentoSubstituido };
}

/** O CPF/CNPJ do formulário ainda é o da empresa consultada? */
export function documentoCorrespondeAEmpresa(cpfCnpj: string, empresa: EmpresaCompleta): boolean {
  return digitosDoDocumento(cpfCnpj) === empresa.cnpj;
}
