import { NextResponse } from 'next/server';
import { bling } from '@/services/bling';
import { financeiroRepository } from '@/repositories/financeiroRepository';
import { verifySessionAndRole } from '@/lib/auth';
import { resolveVerifiedOrganizationScope } from '@/lib/requestOrganizationContext';
import { TituloFinanceiro } from '@/types';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';

export const dynamic = 'force-dynamic';

interface IdCarrier {
  id?: number | string;
  data?: {
    id?: number | string;
  };
}

export async function GET(request: Request) {
  try {
    const session = await verifySessionAndRole(request);
    if (!session) {
      return NextResponse.json({ success: false, error: 'Não autorizado' }, { status: 401 });
    }
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
    console.error('Erro no GET /api/financeiro:', error);
    const errMsg = error instanceof Error ? error.message : 'Erro interno';
    return NextResponse.json(
      { success: false, error: errMsg },
      { status: 500 }
    );
  }
}

type BlingClient = ReturnType<typeof bling.forVerifiedOrganization>;

/**
 * Resolve o contato "Fornecedor Diverso" genérico no Bling: busca por nome e,
 * se não existir, cria. Usado quando o frontend não informa um contato
 * específico para a despesa.
 */
async function resolveGenericFornecedorContatoId(blingClient: BlingClient): Promise<number | null> {
  const NOME_FORNECEDOR = 'Fornecedor Diverso';
  let contatoId: number | null = null;

  try {
    const contatosExistentes = await blingClient.getContatosByNome(NOME_FORNECEDOR);
    const fornecedor = Array.isArray(contatosExistentes) && contatosExistentes.length > 0
      ? contatosExistentes.find((c) => (c.nome || '').toLowerCase().includes('fornecedor diverso')) || contatosExistentes[0]
      : null;

    if (fornecedor) {
      const contatoObj = fornecedor as { id?: number | string; contato?: { id?: number | string } };
      contatoId = Number(contatoObj.id || contatoObj.contato?.id);
    }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.warn('[financeiro] Erro ao buscar contato genérico:', errMsg);
  }

  if (contatoId) return contatoId;

  try {
    const res = (await blingClient.createContato({
      nome: NOME_FORNECEDOR,
      tipo: 'F',
    })) as IdCarrier;
    contatoId = Number(res?.id || res?.data?.id);
  } catch (err: unknown) {
    const errMessage = err instanceof Error ? err.message : String(err);
    console.error('[financeiro] Erro ao criar contato genérico:', errMessage);
  }

  return contatoId || null;
}

/** Resultado da criação de uma conta a pagar diretamente no Bling ERP. */
type ContaPagarBlingResult =
  | { readonly _tag: 'Created'; readonly blingId: number }
  | { readonly _tag: 'Failed'; readonly response: NextResponse };

async function createContaPagarInBling(
  blingClient: BlingClient,
  payload: Record<string, unknown>,
): Promise<ContaPagarBlingResult> {
  let resBling: unknown;
  try {
    resBling = await blingClient.createContaPagar(payload);
  } catch (blingErr: unknown) {
    const blingErrMsg = blingErr instanceof Error ? blingErr.message : String(blingErr);
    console.error('[financeiro] Bling recusou a conta a pagar:', blingErrMsg);
    return {
      _tag: 'Failed',
      response: NextResponse.json({ success: false, error: `Bling recusou o lançamento: ${blingErrMsg}` }, { status: 422 }),
    };
  }

  const resObj = (resBling || {}) as IdCarrier;
  const blingId: number | string | undefined = resObj?.data?.id ?? resObj?.id;

  if (!blingId || Number(blingId) <= 0) {
    return {
      _tag: 'Failed',
      response: NextResponse.json({ success: false, error: 'Bling confirmou mas não retornou o ID da conta criada.' }, { status: 502 }),
    };
  }

  console.log(`[financeiro] ✅ Conta a pagar ${blingId} criada no Bling como 'Em Aberto'.`);
  return { _tag: 'Created', blingId: Number(blingId) };
}

interface CreateDespesaContabilInput {
  readonly descricao: string;
  readonly valor: number;
  readonly data_vencimento: string;
  readonly categoria_id: string | undefined;
  readonly contato_id: string | number | undefined;
  readonly pago: boolean;
}

/**
 * Fluxo "modo contábil": cria a conta a pagar diretamente no Bling ERP (fonte
 * da verdade fiscal) e só então espelha o título no Supabase para controle
 * do aplicativo.
 */
async function createDespesaContabil(
  scope: VerifiedOrganizationScope,
  blingClient: ReturnType<typeof bling.forVerifiedOrganization>,
  input: CreateDespesaContabilInput,
): Promise<NextResponse> {
  // Obter a categoria no Supabase para ver se tem bling_id
  let idCategoriaBling: number | undefined = undefined;
  if (input.categoria_id) {
    const categorias = await financeiroRepository.getCategorias(scope);
    const cat = categorias.find(c => c.id === input.categoria_id);
    if (cat && cat.bling_id) {
      idCategoriaBling = cat.bling_id;
    }
  }

  // Garantir fuso horário local correto
  const agoraStr = new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" });
  const localDate = new Date(agoraStr);
  const hoje = localDate.toISOString().split('T')[0];

  // Lidar com Fornecedor: usa o ID passado pelo frontend ou busca/cria o genérico
  let contatoId: number | null = input.contato_id ? Number(input.contato_id) : null;
  if (!contatoId) {
    contatoId = await resolveGenericFornecedorContatoId(blingClient);
    if (!contatoId) {
      throw new Error('Não foi possível obter o ID do fornecedor no Bling.');
    }
  }

  // 1. Criar a Conta a Pagar como "Em Aberto" no Bling (garante visibilidade e conformidade contábil)
  const payloadPagar = {
    dataEmissao: hoje,
    competencia: hoje,
    vencimento: input.data_vencimento,
    valor: Number(input.valor),
    historico: input.descricao,
    situacao: input.pago ? 2 : 1, // 1 = Em Aberto, 2 = Pago (Quitado) no Bling Contas a Pagar
    categoria: idCategoriaBling ? { id: idCategoriaBling } : undefined,
    contato: { id: contatoId }
  };

  const contaPagarResult = await createContaPagarInBling(blingClient, payloadPagar);
  if (contaPagarResult._tag === 'Failed') return contaPagarResult.response;
  const { blingId } = contaPagarResult;

  // 2. SUPABASE: Espelha o título para controle do aplicativo
  const novoTitulo: TituloFinanceiro = {
    bling_id: blingId,
    tipo: 'pagar',
    situacao: input.pago ? 'pago' : 'aberto',
    valor: Number(input.valor),
    data_vencimento: input.data_vencimento,
    descricao: input.descricao,
    categoria_id: input.categoria_id || undefined,
  };

  const tituloSalvo = await financeiroRepository.upsertTitulo(scope, novoTitulo);
  return NextResponse.json({ success: true, data: tituloSalvo });
}

export async function POST(request: Request) {
  try {
    const session = await verifySessionAndRole(request);
    if (!session) {
      return NextResponse.json({ success: false, error: 'Não autorizado' }, { status: 401 });
    }
    const scopeResult = await resolveVerifiedOrganizationScope(request);
    if (scopeResult._tag !== 'RequestScopeResolved') return scopeResult.response;
    const scope = scopeResult.scope;

    const body = await request.json();
    const { descricao, valor, data_vencimento, data_pagamento, categoria_id, contato_id, modo, pago } = body;

    if (!descricao || !valor || !data_vencimento) {
      return NextResponse.json({ success: false, error: 'Descrição, valor e vencimento são obrigatórios.' }, { status: 400 });
    }

    // ═══════════════════════════════════════════════════
    // MODO INTERNO: Salva SOMENTE no Supabase (Orbita Only)
    // ═══════════════════════════════════════════════════
    if (modo === 'interno') {
      const novoTituloInterno: TituloFinanceiro = {
        bling_id: 0, // 0 indica lançamento exclusivamente interno
        tipo: 'pagar',
        situacao: pago ? 'pago' : 'aberto',
        valor: Number(valor),
        data_vencimento,
        data_pagamento: pago ? (data_pagamento || data_vencimento) : undefined,
        descricao: `[Interno] ${descricao}`,
        categoria_id: categoria_id || undefined,
      };

      const tituloSalvo = await financeiroRepository.upsertTitulo(scope, novoTituloInterno);
      return NextResponse.json({ success: true, data: tituloSalvo });
    }

    // ═══════════════════════════════════════════════════
    // MODO CONTÁBIL: Integrado com o Bling ERP
    // ═══════════════════════════════════════════════════
    const blingClient = bling.forVerifiedOrganization(scope);
    return await createDespesaContabil(scope, blingClient, {
      descricao,
      valor: Number(valor),
      data_vencimento,
      categoria_id,
      contato_id,
      pago: Boolean(pago),
    });

  } catch (error: unknown) {
    console.error('Erro no POST /api/financeiro:', error);
    const errMsg = error instanceof Error ? error.message : 'Erro interno ao criar despesa';
    return NextResponse.json(
      { success: false, error: errMsg },
      { status: 500 }
    );
  }
}
