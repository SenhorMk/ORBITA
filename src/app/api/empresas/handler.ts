import { NextResponse } from 'next/server';

import { cnpjValido, digitosDoDocumento } from '@/lib/documento';
import type { RespostaDaConsultaPorCnpj } from '@/lib/empresas/empresaContract';
import type { RateLimitAction, RateLimitDecision } from '@/lib/rateLimit';
import { escopoTemCapacidade, type VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import type { DesfechoDaConsultaPorCnpj } from '@/services/empresas/consultaPorCnpj';

/**
 * `GET /api/empresas/cnpj/[cnpj]`: os dados cadastrais de uma empresa, para
 * PREENCHER o cadastro de contato. Não grava nada, nem no ORBITA nem no Bling.
 *
 * - Sessão com organização verificada **e** `organization:manage`: é a mesma
 *   capacidade que salvar o contato exige, então quem não pode cadastrar não
 *   gasta consultas.
 * - CNPJ inválido é recusado antes do rate limit e do provedor.
 * - Rate limit por pessoa da organização; armazenamento indisponível nega
 *   (falha fechada).
 * - O endpoint externo é do servidor; nada do cliente vira URL. O log leva só
 *   a categoria da falha, nunca o payload do provedor.
 */

export interface EmpresasDeps {
  readonly autorizar: (request: Request) => Promise<
    | { readonly _tag: 'Autorizado'; readonly scope: VerifiedOrganizationScope }
    | { readonly _tag: 'Negado'; readonly response: NextResponse }
  >;
  readonly limitar: (acao: RateLimitAction, chave: string) => Promise<RateLimitDecision>;
  readonly consultarCnpj: (cnpj: string) => Promise<DesfechoDaConsultaPorCnpj>;
  readonly registrarFalha: (operacao: string, causa: string, organizacaoId: string) => void;
}

const STATUS: Record<RespostaDaConsultaPorCnpj['resultado'], number> = {
  EmpresaEncontrada: 200,
  EmpresaNaoEncontrada: 404,
  CnpjInvalido: 400,
  ConsultaIndisponivel: 503,
  LimiteDeConsultas: 429,
  SemPermissao: 403,
};

const responder = (corpo: RespostaDaConsultaPorCnpj) => NextResponse.json(corpo, { status: STATUS[corpo.resultado] });

export function createConsultaPorCnpjHandler(deps: EmpresasDeps) {
  return async function consultaPorCnpj(request: Request, cnpj: string): Promise<NextResponse> {
    const autorizacao = await deps.autorizar(request);
    if (autorizacao._tag === 'Negado') return autorizacao.response;
    const { scope } = autorizacao;
    if (!escopoTemCapacidade(scope, 'organization:manage')) return responder({ resultado: 'SemPermissao' });

    if (!cnpjValido(cnpj)) return responder({ resultado: 'CnpjInvalido' });

    const limite = await deps.limitar('empresa_cnpj', `${scope.organizationId}:${scope.actorId}`);
    if (limite._tag === 'RateLimitBlocked') return responder({ resultado: 'LimiteDeConsultas' });
    if (limite._tag !== 'RateLimitAllowed') return responder({ resultado: 'ConsultaIndisponivel' });

    const desfecho = await deps.consultarCnpj(digitosDoDocumento(cnpj));
    switch (desfecho._tag) {
      case 'EmpresaEncontrada':
        return responder({ resultado: 'EmpresaEncontrada', empresa: desfecho.empresa });
      case 'EmpresaNaoEncontrada':
        return responder({ resultado: 'EmpresaNaoEncontrada' });
      case 'CnpjInvalido':
        return responder({ resultado: 'CnpjInvalido' });
      case 'ConsultaIndisponivel':
        deps.registrarFalha('empresas.consulta_cnpj', desfecho.causa, scope.organizationId);
        return responder({ resultado: 'ConsultaIndisponivel' });
    }
  };
}
