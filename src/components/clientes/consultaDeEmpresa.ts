import { cnpjValido, digitosDoCnpj, formatarCnpj } from '@/lib/empresas/cnpj';
import {
  respostaDaBuscaSchema,
  respostaDaConsultaPorCnpjSchema,
  TERMO_MINIMO,
  type EmpresaCompleta,
  type RespostaDaBusca,
  type RespostaDaConsultaPorCnpj,
} from '@/lib/empresas/empresaContract';

/**
 * O lado do navegador da busca de empresa: as chamadas às rotas do ORBITA e a
 * regra de preenchimento do formulário. Nada aqui grava: preencher é só
 * sugerir; quem salva é "Salvar contato", pelo fluxo de sempre.
 */

/** `fetch` autenticado (`fetchWithAuth`) — o mesmo do resto da tela. */
export type BuscaAutenticada = (url: string, opcoes?: RequestInit) => Promise<Response>;

/** O que fazer com o que a pessoa digitou. */
export type Intencao =
  | { readonly _tag: 'Curto' }
  | { readonly _tag: 'Cnpj'; readonly cnpj: string }
  | { readonly _tag: 'Nome'; readonly termo: string };

export function intencaoDaBusca(texto: string): Intencao {
  const limpo = texto.trim();
  // Só dígitos e pontuação de CNPJ, 14 dígitos válidos: é consulta direta.
  if (/^[\d./\-\s]+$/u.test(limpo) && cnpjValido(limpo)) return { _tag: 'Cnpj', cnpj: digitosDoCnpj(limpo) };
  return limpo.length < TERMO_MINIMO ? { _tag: 'Curto' } : { _tag: 'Nome', termo: limpo };
}

async function lerJson(resposta: Response): Promise<unknown> {
  try {
    return await resposta.json();
  } catch {
    return null;
  }
}

/** Resposta fora do contrato vira "indisponível" — nunca eco do corpo. */
export async function buscarEmpresas(termo: string, buscar: BuscaAutenticada, sinal?: AbortSignal): Promise<RespostaDaBusca> {
  const resposta = await buscar(`/api/empresas/busca?termo=${encodeURIComponent(termo)}`, { signal: sinal });
  const lido = respostaDaBuscaSchema.safeParse(await lerJson(resposta));
  return lido.success ? lido.data : { resultado: 'BuscaIndisponivel' };
}

export async function consultarCnpj(cnpj: string, buscar: BuscaAutenticada, sinal?: AbortSignal): Promise<RespostaDaConsultaPorCnpj> {
  const resposta = await buscar(`/api/empresas/cnpj/${digitosDoCnpj(cnpj)}`, { signal: sinal });
  const lido = respostaDaConsultaPorCnpjSchema.safeParse(await lerJson(resposta));
  return lido.success ? lido.data : { resultado: 'ConsultaIndisponivel' };
}

/** Os campos do formulário de contato que a busca preenche. `tipo` é decidido à parte. */
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

/**
 * Preenche sem atropelar quem digitou.
 *
 * Um campo é da PESSOA quando tem valor e esse valor não é o que a busca
 * anterior colocou lá. Esses ficam como estão e voltam em `mantidos`. Os
 * demais — vazios, ou ainda com o valor de uma busca anterior — recebem o da
 * empresa nova: escolher outra empresa troca o que a busca tinha posto.
 */
export function preencherComEmpresa(
  atuais: ValoresDoFormulario,
  daBuscaAnterior: Partial<ValoresDoFormulario>,
  empresa: EmpresaCompleta,
): { readonly valores: ValoresDoFormulario; readonly daBusca: ValoresDoFormulario; readonly mantidos: readonly CampoPreenchido[] } {
  const encontrados = valoresDaEmpresa(empresa);
  const valores = { ...atuais };
  const mantidos: CampoPreenchido[] = [];
  for (const campo of CAMPOS_PREENCHIDOS) {
    const atual = atuais[campo].trim();
    const editadoPelaPessoa = atual !== '' && atual !== (daBuscaAnterior[campo] ?? '').trim();
    if (editadoPelaPessoa) {
      if (atual !== encontrados[campo].trim()) mantidos.push(campo);
      continue;
    }
    valores[campo] = encontrados[campo];
  }
  return { valores, daBusca: encontrados, mantidos };
}
