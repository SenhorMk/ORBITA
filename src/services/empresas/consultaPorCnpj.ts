import { z } from 'zod';

import { cnpjValido, digitosDoCnpj } from '@/lib/empresas/cnpj';
import type { EmpresaCompleta } from '@/lib/empresas/empresaContract';

/**
 * Consulta de dados cadastrais por CNPJ — a ÚNICA do ORBITA. Serve o cadastro
 * de contatos e o cadastro de fornecedor do Financeiro, que antes chamava a
 * BrasilAPI direto do navegador e espalhava o mapeamento pelos componentes.
 *
 * Roda só no servidor: o endpoint vem da ligação de produção (`BRASILAPI_CNPJ_URL`,
 * só do servidor, ou o padrão da BrasilAPI), nunca de uma URL vinda do cliente; o payload do provedor é validado
 * e reduzido ao vocabulário do ORBITA antes de sair.
 */

export type DesfechoDaConsultaPorCnpj =
  | { readonly _tag: 'EmpresaEncontrada'; readonly empresa: EmpresaCompleta }
  | { readonly _tag: 'EmpresaNaoEncontrada' }
  | { readonly _tag: 'CnpjInvalido' }
  | { readonly _tag: 'ConsultaIndisponivel'; readonly causa: string };

const TEMPO_LIMITE_MS = 8_000;

const opcional = z.string().nullish().transform((v) => (v && v.trim() ? v.trim() : null));
const numeroOuTexto = z.union([z.string(), z.number()]).nullish().transform((v) => (v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim()));

/** O que a BrasilAPI devolve e o ORBITA usa. O resto é descartado. */
const payloadBrasilApiSchema = z.object({
  cnpj: z.union([z.string(), z.number()]).transform((v) => digitosDoCnpj(String(v)).padStart(14, '0')),
  razao_social: z.string().trim().min(1),
  nome_fantasia: opcional,
  descricao_situacao_cadastral: opcional,
  email: opcional,
  ddd_telefone_1: opcional,
  cep: numeroOuTexto,
  logradouro: opcional,
  numero: numeroOuTexto,
  bairro: opcional,
  municipio: opcional,
  uf: opcional,
});

export function empresaDaBrasilApi(payload: unknown): EmpresaCompleta | null {
  const lido = payloadBrasilApiSchema.safeParse(payload);
  if (!lido.success) return null;
  const d = lido.data;
  return {
    cnpj: d.cnpj,
    razaoSocial: d.razao_social,
    nomeFantasia: d.nome_fantasia,
    situacao: d.descricao_situacao_cadastral,
    email: d.email ? d.email.toLowerCase() : null,
    telefone: d.ddd_telefone_1,
    cep: d.cep ? digitosDoCnpj(d.cep).padStart(8, '0') : null,
    logradouro: d.logradouro,
    numero: d.numero,
    bairro: d.bairro,
    municipio: d.municipio,
    uf: d.uf ? d.uf.toUpperCase() : null,
  };
}

export interface ConsultaPorCnpjDeps {
  readonly fetch: typeof fetch;
  /** Endpoint de consulta, decidido no servidor. */
  readonly baseUrl: string;
}

export async function consultarEmpresaPorCnpj(cnpj: string, deps: ConsultaPorCnpjDeps): Promise<DesfechoDaConsultaPorCnpj> {
  if (!cnpjValido(cnpj)) return { _tag: 'CnpjInvalido' };
  const base = deps.baseUrl.trim().replace(/\/+$/u, '');

  let resposta: Response;
  try {
    resposta = await deps.fetch(`${base}/${digitosDoCnpj(cnpj)}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(TEMPO_LIMITE_MS),
      cache: 'no-store',
    });
  } catch (erro: unknown) {
    return { _tag: 'ConsultaIndisponivel', causa: erro instanceof Error ? erro.name : 'rede' };
  }

  if (resposta.status === 404) return { _tag: 'EmpresaNaoEncontrada' };
  if (resposta.status === 400) return { _tag: 'CnpjInvalido' };
  if (!resposta.ok) return { _tag: 'ConsultaIndisponivel', causa: `http_${resposta.status}` };

  let corpo: unknown;
  try {
    corpo = await resposta.json();
  } catch {
    return { _tag: 'ConsultaIndisponivel', causa: 'json_invalido' };
  }
  const empresa = empresaDaBrasilApi(corpo);
  return empresa ? { _tag: 'EmpresaEncontrada', empresa } : { _tag: 'ConsultaIndisponivel', causa: 'contrato_inesperado' };
}
