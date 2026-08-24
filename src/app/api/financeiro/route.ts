import { NextResponse } from 'next/server';
import { bling } from '@/services/bling';
import { financeiroRepository } from '@/repositories/financeiroRepository';
import { verifySessionAndRole } from '@/lib/auth';
import { TituloFinanceiro } from '@/types';

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

    const { searchParams } = new URL(request.url);
    const tipo = searchParams.get('tipo') as 'receber' | 'pagar' | null;
    const situacao = searchParams.get('situacao') || undefined;


    const [resumo, titulos, categorias] = await Promise.all([
      financeiroRepository.getResumo(session.tenant),
      financeiroRepository.getTitulosFiltro(session.tenant, { tipo: tipo || undefined, situacao }),
      financeiroRepository.getCategorias(session.tenant)
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

export async function POST(request: Request) {
  try {
    const session = await verifySessionAndRole(request);
    if (!session) {
      return NextResponse.json({ success: false, error: 'Não autorizado' }, { status: 401 });
    }

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

      const tituloSalvo = await financeiroRepository.upsertTitulo(session.tenant, novoTituloInterno);
      return NextResponse.json({ success: true, data: tituloSalvo });
    }

    // ═══════════════════════════════════════════════════
    // MODO CONTÁBIL: Integrado com o Bling ERP
    // ═══════════════════════════════════════════════════
    const blingClient = bling.forUser(session.tenant);

    // Obter a categoria no Supabase para ver se tem bling_id
    let idCategoriaBling: number | undefined = undefined;
    if (categoria_id) {
      const categorias = await financeiroRepository.getCategorias(session.tenant);
      const cat = categorias.find(c => c.id === categoria_id);
      if (cat && cat.bling_id) {
        idCategoriaBling = cat.bling_id;
      }
    }

    // Garantir fuso horário local correto
    const agoraStr = new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" });
    const localDate = new Date(agoraStr);
    const hoje = localDate.toISOString().split('T')[0];

    // Lidar com Fornecedor: usa o ID passado pelo frontend ou busca/cria o genérico
    let contatoId: number | null = contato_id ? Number(contato_id) : null;

    if (!contatoId) {
      const NOME_FORNECEDOR = 'Fornecedor Diverso';
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

      if (!contatoId) {
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
      }

      if (!contatoId) {
        throw new Error('Não foi possível obter o ID do fornecedor no Bling.');
      }
    }

    // 1. Criar a Conta a Pagar como "Em Aberto" no Bling (garante visibilidade e conformidade contábil)
    const payloadPagar = {
      dataEmissao: hoje,
      competencia: hoje,
      vencimento: data_vencimento,
      valor: Number(valor),
      historico: descricao,
      situacao: pago ? 2 : 1, // 1 = Em Aberto, 2 = Pago (Quitado) no Bling Contas a Pagar
      categoria: idCategoriaBling ? { id: idCategoriaBling } : undefined,
      contato: { id: contatoId }
    };

    let resBling: unknown;
    try {
      resBling = await blingClient.createContaPagar(payloadPagar);
    } catch (blingErr: unknown) {
      const blingErrMsg = blingErr instanceof Error ? blingErr.message : String(blingErr);
      console.error('[financeiro] Bling recusou a conta a pagar:', blingErrMsg);
      return NextResponse.json(
        { success: false, error: `Bling recusou o lançamento: ${blingErrMsg}` },
        { status: 422 }
      );
    }

    const resObj = (resBling || {}) as IdCarrier;
    const blingId: number | string | undefined = resObj?.data?.id ?? resObj?.id;

    if (!blingId || Number(blingId) <= 0) {
      return NextResponse.json(
        { success: false, error: 'Bling confirmou mas não retornou o ID da conta criada.' },
        { status: 502 }
      );
    }

    console.log(`[financeiro] ✅ Conta a pagar ${blingId} criada no Bling como 'Em Aberto'.`);

    // 2. SUPABASE: Espelha o título para controle do aplicativo
    const novoTitulo: TituloFinanceiro = {
      bling_id: Number(blingId),
      tipo: 'pagar',
      situacao: pago ? 'pago' : 'aberto',
      valor: Number(valor),
      data_vencimento,
      descricao,
      categoria_id: categoria_id || undefined,
    };

    const tituloSalvo = await financeiroRepository.upsertTitulo(session.tenant, novoTitulo);

    return NextResponse.json({ success: true, data: tituloSalvo });

  } catch (error: unknown) {
    console.error('Erro no POST /api/financeiro:', error);
    const errMsg = error instanceof Error ? error.message : 'Erro interno ao criar despesa';
    return NextResponse.json(
      { success: false, error: errMsg },
      { status: 500 }
    );
  }
}
