import { NextResponse } from 'next/server';
import { bling } from '@/services/bling';
import type { BlingPort } from '@/services/blingPort';
import { financeiroRepository } from '@/repositories/financeiroRepository';
import { organizationContextStatus } from '@/lib/organizationAuthorization';
import { logger } from '@/lib/observability/logger';
import {
  resolveActiveRequestOrganizationContext,
  resolveVerifiedOrganizationScope,
} from '@/lib/requestOrganizationContext';
import { supabaseServer } from '@/lib/supabaseServer';
import { TituloFinanceiro } from '@/types';
import { organizationContextToScope } from '@/lib/verifiedOrganizationScope';
import type { BlingCallResult } from '@/lib/integrations/bling/pedidoVendaContract';

import { registrarFalhaInterna, MENSAGEM_PUBLICA_DE_FALHA } from '@/lib/observability/falhaInterna';

import {
  createDespesaHandler,
  type DespesaAuthPort,
  type DespesaBlingPort,
  type DespesaStorePort,
} from './despesaHandler';
import { tentativasDeContaPagarStore } from './tentativasDeContaPagarStore';

export type { DespesaBlingPort, DespesaDependencies, DespesaStorePort } from './despesaHandler';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    // O escopo de organização resolve identidade e vínculo, e distingue 401
    // (sem sessão), 403 (sem vínculo) e 503 (indisponível).
    const scopeResult = await resolveVerifiedOrganizationScope(request);
    if (scopeResult._tag !== 'RequestScopeResolved') return scopeResult.response;
    const scope = scopeResult.scope;

    const { searchParams } = new URL(request.url);
    const tipo = searchParams.get('tipo') as 'receber' | 'pagar' | null;
    const situacao = searchParams.get('situacao') || undefined;


    const [resumo, titulos, categorias] = await Promise.all([
      financeiroRepository.getResumo(scope),
      financeiroRepository.getTitulosFiltro(scope, { tipo: tipo || undefined, situacao }),
      financeiroRepository.getCategorias(scope)
    ]);

    return NextResponse.json({
      success: true,
      data: {
        resumo,
        titulos,
        categorias
      }
    });

  } catch (error: unknown) {
    // A mensagem do erro não vai ao cliente (CWE-209): diagnóstico no log,
    // frase pública fixa na resposta.
    registrarFalhaInterna('financeiro.listar', error);
    return NextResponse.json(
      { success: false, error: MENSAGEM_PUBLICA_DE_FALHA },
      { status: 500 }
    );
  }
}


const NOME_FORNECEDOR_PADRAO = 'Fornecedor Diverso';

/**
 * Contato usado quando o lançamento não informa um fornecedor: procura o
 * "Fornecedor Diverso" e o cria se não existir.
 */
async function resolverContatoPadrao(blingClient: BlingPort): Promise<BlingCallResult<number>> {
  try {
    const existentes = await blingClient.getContatosByNome(NOME_FORNECEDOR_PADRAO);
    const encontrado = Array.isArray(existentes)
      ? existentes.find((c) => (c.nome || '').toLowerCase().includes('fornecedor diverso')) ?? existentes[0]
      : null;

    if (encontrado) {
      const id = Number((encontrado as { id?: number | string }).id);
      if (Number.isSafeInteger(id) && id > 0) return { _tag: 'BlingOk', value: id };
    }
  } catch (error: unknown) {
    logger.warn('financeiro.contato_padrao_busca_falhou', {
      subsystem: 'app',
      provider: 'bling',
      reason: error instanceof Error ? error.name : 'unknown',
    });
  }

  const criado = await blingClient.criarContato({
    nome: NOME_FORNECEDOR_PADRAO,
    tipo: 'J',
    indicadorIe: 9,
  });
  if (criado._tag === 'BlingFailed') return criado;
  return { _tag: 'BlingOk', value: Number(criado.value.id) };
}

/** Data de hoje em `America/Sao_Paulo`, no formato `AAAA-MM-DD`. */
function hojeEmSaoPaulo(): string {
  // `Intl` com `en-CA` já devolve AAAA-MM-DD. A versão anterior fazia
  // `toLocaleString('en-US', {timeZone})` → `new Date(...)` → `toISOString()`,
  // que reinterpreta a hora local como UTC e erra o dia perto da meia-noite.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function blingDespesaAdapter(client: BlingPort): DespesaBlingPort {
  return {
    resolverContatoPadrao: () => resolverContatoPadrao(client),
    criarContaPagar: (payload) => client.criarContaPagar(payload),
    obterPortadorPadrao: () => client.obterContaFinanceiraPadraoId(),
    baixarContaPagar: (id, payload) => client.baixarContaPagar(id, payload),
  };
}

const despesaStore: DespesaStorePort = {
  ...tentativasDeContaPagarStore,

  async resolverCategoriaBling(scope, categoriaId) {
    const { data } = await supabaseServer
      .from('categorias_financeiras')
      .select('bling_id')
      .eq('organizacao_id', scope.organizationId)
      .eq('id', categoriaId)
      .maybeSingle();

    const blingId = Number(data?.bling_id);
    return Number.isSafeInteger(blingId) && blingId > 0 ? blingId : null;
  },

  async salvarTitulo(scope, titulo) {
    const essencial = {
      bling_id: titulo.blingId ?? undefined,
      tipo: 'pagar',
      situacao: titulo.situacao,
      valor: titulo.valor,
      data_vencimento: titulo.dataVencimento,
      descricao: titulo.descricao,
      categoria_id: titulo.categoriaId,
    } as TituloFinanceiro;

    const completo = {
      ...essencial,
      titulo: titulo.titulo,
      fornecedor_bling_id: titulo.fornecedorBlingId,
      fornecedor_nome: titulo.fornecedorNome,
    } as TituloFinanceiro;

    let salvo: TituloFinanceiro;
    let aviso: string | undefined;
    try {
      salvo = await financeiroRepository.upsertTitulo(scope, completo);
    } catch (erro: unknown) {
      // `PGRST204` é o PostgREST dizendo que a coluna não existe NESTE banco —
      // a migration 62 ainda não foi aplicada aqui. Isso não é motivo para
      // recusar a despesa: valor, data, categoria e situação são o que a
      // contabilidade precisa, e eles cabem no esquema antigo. O que não cabe
      // é dito em voz alta, em vez de sumir.
      if (!esquemaSemColunasNovas(erro)) throw erro;
      salvo = await financeiroRepository.upsertTitulo(scope, essencial);
      aviso = 'A despesa foi gravada, mas o título e o fornecedor não foram registrados: '
        + 'a migration 62 ainda não foi aplicada neste banco.';
    }

    return {
      id: String(salvo.id ?? ''),
      blingId: salvo.bling_id ? String(salvo.bling_id) : null,
      situacao: salvo.situacao ?? titulo.situacao,
      ...(aviso ? { aviso } : {}),
    };
  },
};

/**
 * O banco ainda não tem as colunas que a migration 62 cria?
 *
 * O sinal é o `code` do PostgREST, e não o texto da mensagem: `PGRST204` é
 * "coluna não encontrada no cache de esquema". A causa vem anexada ao erro que
 * o repositório lança justamente para esta pergunta poder ser feita.
 */
function esquemaSemColunasNovas(erro: unknown): boolean {
  const causa = erro instanceof Error ? erro.cause : erro;
  return typeof causa === 'object' && causa !== null && (causa as { code?: unknown }).code === 'PGRST204';
}

const despesaAuth: DespesaAuthPort = {
  async authorize(request: Request) {
    const contextResult = await resolveActiveRequestOrganizationContext(request);
    if (contextResult._tag !== 'OrganizationContextResolved') {
      const status = organizationContextStatus(contextResult);
      return {
        _tag: 'Denied' as const,
        response: NextResponse.json(
          { success: false, error: status === 503 ? 'Serviço de autorização indisponível' : 'Não autorizado' },
          { status },
        ),
      };
    }
    if (!contextResult.context.capabilities.has('organization:manage')) {
      return {
        _tag: 'Denied' as const,
        response: NextResponse.json(
          { success: false, error: 'Capacidade insuficiente para lançar despesas' },
          { status: 403 },
        ),
      };
    }
    return { _tag: 'Authorized' as const, scope: organizationContextToScope(contextResult.context) };
  },
};

export async function POST(request: Request): Promise<NextResponse> {
  const authorization = await despesaAuth.authorize(request);
  if (authorization._tag === 'Denied') return authorization.response;

  const handler = createDespesaHandler({
    auth: { async authorize() { return authorization; } },
    bling: blingDespesaAdapter(bling.forVerifiedOrganization(authorization.scope)),
    store: despesaStore,
    hoje: hojeEmSaoPaulo,
    novaChave: () => crypto.randomUUID(),
  });

  return handler(request);
}
