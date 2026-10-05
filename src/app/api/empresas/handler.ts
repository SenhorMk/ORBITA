import { NextResponse } from 'next/server';

import {
  MAXIMO_DE_SUGESTOES,
  type RespostaDaBusca,
  type RespostaDaConsultaPorCnpj,
} from '@/lib/empresas/empresaContract';
import type { RateLimitAction, RateLimitDecision } from '@/lib/rateLimit';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import type { DesfechoDaConsultaPorCnpj } from '@/services/empresas/consultaPorCnpj';
import { termoDeBusca, type EmpresaSearchProvider } from '@/services/empresas/buscaDeEmpresas';

/**
 * `GET /api/empresas/cnpj/[cnpj]` e `GET /api/empresas/busca?termo=`.
 *
 * Ajudam a PREENCHER formulários (contato, fornecedor); não gravam nada, nem
 * no ORBITA nem no Bling. Exigem sessão com organização verificada e têm rate
 * limit por pessoa e organização. Nada do cliente vira URL ou credencial: o
 * CNPJ e o termo são validados aqui, o provedor e a chave são do servidor. O
 * termo e o payload do provedor não vão para o log.
 */

export interface EmpresasDeps {
  readonly autorizar: (request: Request) => Promise<
    | { readonly _tag: 'Autorizado'; readonly scope: VerifiedOrganizationScope }
    | { readonly _tag: 'Negado'; readonly response: NextResponse }
  >;
  readonly limitar: (acao: RateLimitAction, chave: string) => Promise<RateLimitDecision>;
  readonly consultarCnpj: (cnpj: string) => Promise<DesfechoDaConsultaPorCnpj>;
  readonly provedor: () => EmpresaSearchProvider | null;
  readonly registrarFalha: (operacao: string, causa: string, organizacaoId: string) => void;
}

const STATUS_DA_CONSULTA: Record<RespostaDaConsultaPorCnpj['resultado'], number> = {
  EmpresaEncontrada: 200,
  EmpresaNaoEncontrada: 404,
  CnpjInvalido: 400,
  ConsultaIndisponivel: 503,
  LimiteDeConsultas: 429,
};

const STATUS_DA_BUSCA: Record<RespostaDaBusca['resultado'], number> = {
  Empresas: 200,
  TermoInvalido: 400,
  BuscaPorNomeIndisponivel: 200,
  BuscaIndisponivel: 503,
  LimiteDeConsultas: 429,
};

const responderConsulta = (corpo: RespostaDaConsultaPorCnpj) => NextResponse.json(corpo, { status: STATUS_DA_CONSULTA[corpo.resultado] });
const responderBusca = (corpo: RespostaDaBusca) => NextResponse.json(corpo, { status: STATUS_DA_BUSCA[corpo.resultado] });

/**
 * Limite por pessoa dentro da organização. Estourado é 429; o armazenamento do
 * limite indisponível também nega (falha fechada), como serviço indisponível.
 */
async function limite(deps: EmpresasDeps, acao: RateLimitAction, scope: VerifiedOrganizationScope) {
  const decisao = await deps.limitar(acao, `${scope.organizationId}:${scope.actorId}`);
  return decisao._tag === 'RateLimitAllowed' ? 'Livre' : decisao._tag === 'RateLimitBlocked' ? 'Estourado' : 'Indisponivel';
}

export function createConsultaPorCnpjHandler(deps: EmpresasDeps) {
  return async function consultaPorCnpj(request: Request, cnpj: string): Promise<NextResponse> {
    const autorizacao = await deps.autorizar(request);
    if (autorizacao._tag === 'Negado') return autorizacao.response;
    const { scope } = autorizacao;
    const situacao = await limite(deps, 'empresa_cnpj', scope);
    if (situacao === 'Estourado') return responderConsulta({ resultado: 'LimiteDeConsultas' });
    if (situacao === 'Indisponivel') return responderConsulta({ resultado: 'ConsultaIndisponivel' });

    const desfecho = await deps.consultarCnpj(cnpj);
    switch (desfecho._tag) {
      case 'EmpresaEncontrada':
        return responderConsulta({ resultado: 'EmpresaEncontrada', empresa: desfecho.empresa });
      case 'EmpresaNaoEncontrada':
        return responderConsulta({ resultado: 'EmpresaNaoEncontrada' });
      case 'CnpjInvalido':
        return responderConsulta({ resultado: 'CnpjInvalido' });
      case 'ConsultaIndisponivel':
        deps.registrarFalha('empresas.consulta_cnpj', desfecho.causa, scope.organizationId);
        return responderConsulta({ resultado: 'ConsultaIndisponivel' });
    }
  };
}

export function createBuscaDeEmpresasHandler(deps: EmpresasDeps) {
  return async function buscaDeEmpresas(request: Request): Promise<NextResponse> {
    const autorizacao = await deps.autorizar(request);
    if (autorizacao._tag === 'Negado') return autorizacao.response;
    const { scope } = autorizacao;

    const termo = termoDeBusca(new URL(request.url).searchParams.get('termo'));
    if (termo === null) return responderBusca({ resultado: 'TermoInvalido' });

    const provedor = deps.provedor();
    if (provedor === null) return responderBusca({ resultado: 'BuscaPorNomeIndisponivel' });
    const situacao = await limite(deps, 'empresa_busca', scope);
    if (situacao === 'Estourado') return responderBusca({ resultado: 'LimiteDeConsultas' });
    if (situacao === 'Indisponivel') return responderBusca({ resultado: 'BuscaIndisponivel' });

    try {
      const empresas = await provedor.buscar(termo, MAXIMO_DE_SUGESTOES);
      return responderBusca({ resultado: 'Empresas', empresas: empresas.slice(0, MAXIMO_DE_SUGESTOES) });
    } catch (erro: unknown) {
      // Só a categoria: nem o termo, nem a resposta do provedor, nem a chave.
      deps.registrarFalha('empresas.busca', erro instanceof Error ? erro.name : 'desconhecido', scope.organizationId);
      return responderBusca({ resultado: 'BuscaIndisponivel' });
    }
  };
}
